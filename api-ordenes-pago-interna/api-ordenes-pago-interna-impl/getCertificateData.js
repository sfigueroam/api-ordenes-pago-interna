'use strict';
const AWS = require("aws-sdk");
AWS.config.update({
    region: "us-east-1"
});
var docClient = new AWS.DynamoDB.DocumentClient();
const _ = require('lodash');
const logger = require('./logger');
const dynamo = require('./aws/dynamodbServices');
const s3 = require('./aws/s3Services');
const funciones = require('./utils/funciones');

function validateFormat(event) {
    let pathParameters = event.pathParameters;

    let errors = [];
    
    if (_.isUndefined(pathParameters) || !pathParameters.hasOwnProperty("id")) {
        errors.push(`El pathParameter id debe ser un entero mayor a 0`);
    }
    
    if (_.isUndefined(pathParameters) || !pathParameters.hasOwnProperty("rut")) {
        errors.push(`El pathParameter rut es obligatorio`);
    }
    
    return errors;
}

async function doit(pathParameters, callback) {
    let id = pathParameters.id;
    let rutLogueado = pathParameters.rut;
    let errors = [];
    
    //1.- generar data "beneficiario" desde el resumen

    let resumen = await dynamo.getItem({
        TableName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen`,
        Key: {
            idResumen: String(id)
        }
    });
    
    if(!resumen.hasOwnProperty("estado") || resumen.estado!="CONFIRMADO"){
        
        let salida = errors.push("No existe el certificado con pago en estado CONFIRMADO");
        let status = 404;
        const response = {
            statusCode: status,
            body: JSON.stringify(salida),
            headers: {
                "Access-Control-Allow-Origin": "*", // Required for CORS support to work
                "Access-Control-Allow-Credentials": true, // Required for cookies, authorization headers with HTTPS
                'Accept': 'application/json, text/plain, */*',
                'Content-Type': 'application/json'
            }
        };
        return response;
        
    }
    
    //2.- ir a detalle en dynamo y obtener las trx con el idResumen
    var params = {
        TableName: `tgr-${process.env.ENV}-core-ordenes-pago-detalles`,
        IndexName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen-idx`,
        KeyConditionExpression : "idResumen = :id",
        ExpressionAttributeValues : {
            ":id": String(id)
        }
    };


    /*if(rutMandante!=null){ //si es comporbante endosado
        params.ExpressionAttributeValues = {
            ":id": String(id),
            ":rutMandante": Number(rutMandante)
        };
        
        params.FilterExpression = 'rutMandante = :rutMandante';
        
    }*/
    
    return new Promise((resolve, reject) => {
        docClient.query(params, async function(err, data) {
            if (err) {
                console.log("dynamodb query error:", JSON.stringify(err, null, 2), err.stack);
                reject(err);
            }
            else {
                let salida; let status;
                
                if(data.Count>0){
                    let detalle = data.Items[0];
                    
                    if( rutLogueado!=null && rutLogueado != resumen.rut){
                        
                        salida = await dataCertificadoMandante(resumen, detalle);
                        
                    } else if(rutLogueado == null || rutLogueado == resumen.rut) {
                        salida = await dataCertificado(resumen, detalle);
                    }
                    
                    status = 200;
                    
                } else {
                    salida = errors.push("No existe el certificado con pago en estado CONFIRMADO");
                    status = 404;
                }
                
                const response = {
                    statusCode: status,
                    body: JSON.stringify(salida),
                    headers: {
                        "Access-Control-Allow-Origin": "*", // Required for CORS support to work
                        "Access-Control-Allow-Credentials": true, // Required for cookies, authorization headers with HTTPS
                        'Accept': 'application/json, text/plain, */*',
                        'Content-Type': 'application/json'
                    }
                };
                resolve(response);
            }
        });
    });

}


module.exports.handler = async(event, context, callback) => {
    logger.log('call', event);

    let errors = validateFormat(event);

    if (!_.isEmpty(errors)) {
        response(400, { errors: errors }, callback);
        return;
    }

    return doit(event.pathParameters, callback);

};

function response(code, resultado, callback) {
    const response = {
        statusCode: code,
        body: JSON.stringify(resultado),
        headers: {
            "Access-Control-Allow-Origin": "*", // Required for CORS support to work
            "Access-Control-Allow-Credentials": true, // Required for cookies, authorization headers with HTTPS
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json'
        }
    };

    console.log('response statusCode', response.statusCode);
    callback(null, response);
}

async function dataCertificado(resumenData, detalleData) {

    resumenData = replace_Elements(resumenData);
    let monto = resumenData.monto;
    
    let beneficiario, rut,dv;
    let paterno =  resumenData.beneficiario.paterno;
    let materno = (resumenData.beneficiario.hasOwnProperty("materno") && _.size(resumenData.beneficiario.materno) > 0) ? resumenData.beneficiario.materno + " " : "";
    let nombres = (resumenData.beneficiario.hasOwnProperty("nombres") && _.size(resumenData.beneficiario.nombres) > 0) ? resumenData.beneficiario.nombres + " " : "";
    
    beneficiario = nombres+materno+paterno;
    rut = resumenData.rut;
    dv = digitoVerificador(resumenData.rut);
    
    let datos_pago = {};
    if(detalleData.data.uploadMedioPago == "DEPOSITO"){

        datos_pago = {
                                fechaPago: {
                                    etiqueta: "Fecha de Pago",
                                    prioridad: "A",
                                    tipo: "date",
                                    valor: resumenData.fechaPago
                                },
                                monto: {
                                    etiqueta: "Monto",
                                    prioridad: "B",
                                    tipo: "string",
                                    valor: funciones.separadorMiles(monto)+" "+resumenData.moneda
                                },
                                banco: {
                                    etiqueta: "Banco",
                                    prioridad: "C",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadNombreBanco)
                                },
                                cuenta: {
                                    etiqueta: "Cuenta",
                                    prioridad: "D",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadNumeroCuenta)
                                },
                                tipoCuenta: {
                                    etiqueta: "Tipo de Cuenta",
                                    prioridad: "E",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadTipoCuenta)
                                },
                                medioPago: {
                                    etiqueta: "Medio de Pago",
                                    prioridad: "F",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadMedioPago)
                                }
                            };
    
    }
    
    else if(detalleData.data.uploadMedioPago == "CHEQUE"){

        datos_pago = {
                                fechaPago: {
                                    etiqueta: "Fecha de Pago",
                                    prioridad: "A",
                                    tipo: "date",
                                    valor: resumenData.fechaPago
                                },
                                monto: {
                                    etiqueta: "Monto",
                                    prioridad: "B",
                                    tipo: "string",
                                    valor: funciones.separadorMiles(monto)+" "+resumenData.moneda
                                },
                                direccion: {
                                    etiqueta: "Dirección",
                                    prioridad: "C",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadDireccionEnvio)
                                },
                                comuna: {
                                    etiqueta: "Comuna",
                                    prioridad: "D",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadNombreComuna)
                                },
                                medioPago: {
                                    etiqueta: "Medio de Pago",
                                    prioridad: "F",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadMedioPago)
                                }
                            };
                            
        if(detalleData.data.uploadEstadoOrdenPago=="DOCUMENTO_ENVIADO" && detalleData.data.uploadFechaReemplazo){
            let fechaAct= {
                                etiqueta: "Fecha de Actualización",
                                prioridad: "G",
                                tipo: "string",
                                valor: _.trim(detalleData.data.uploadFechaReemplazo)
                            };
            let numDoc = {
                                etiqueta: "Identificador de Pago",
                                prioridad: "H",
                                tipo: "number",
                                valor:_.trim(detalleData.data.uploadIdDocumentoPago)
                          };
                        
            datos_pago.fechaActualizacion = fechaAct;
            datos_pago.numeroDocumento = numDoc;
        }
    
    }
    
    else if(detalleData.data.uploadMedioPago == "CAJA"){

        datos_pago = {
                                fechaPago: {
                                    etiqueta: "Fecha de Pago",
                                    prioridad: "A",
                                    tipo: "date",
                                    valor: resumenData.fechaPago
                                },
                                monto: {
                                    etiqueta: "Monto",
                                    prioridad: "B",
                                    tipo: "string",
                                    valor: funciones.separadorMiles(monto)+" "+resumenData.moneda
                                },
                                medioPago: {
                                    etiqueta: "Medio de Pago",
                                    prioridad: "F",
                                    tipo: "string",
                                    valor: detalleData.data.uploadMedioPago
                                }
                            };
                            
        if(detalleData.data.uploadEstadoOrdenPago=="DOCUMENTO_ENVIADO" && detalleData.data.uploadFechaReemplazo){
            let fechaAct= {
                                etiqueta: "Fecha de Actualización",
                                prioridad: "G",
                                tipo: "string",
                                valor: _.trim(detalleData.data.uploadFechaReemplazo)
                            };
            
            datos_pago.fechaActualizacion = fechaAct;
        }
        
    }
    
    let certificadoData = {
        certificador: {
            prioridad: "A",
            tipo: "certificador",
            valor: {
                primario: {
                    prioridad: "A",
                    tipo: "institucion",
                    valor: {
                        id: {
                            valor: "tesoreria"
                        },
                        logo: {
                            tipo: "base64",
                            valor: "iVBORw0KGgoAAAANSUhEUgAAA9sAAADbCAYAAAB9YYJBAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAFk5SURBVHhe7Z3dkhTHua4rq3qwwijC6AoE3gfeliEY7FixDzVcgcQVCMKw9iGaK0BcAXC4FzhAV4B0uk9oHe+waQJsr3WwDL4CoQjhkOjuyv292Vk9VdXd0/WT1Z1Z9T4Rw1Q1M9PVWZlZ+X75/aiI1OYfn/zhXqT1kUrn1y7814s39mVCCCGEEEIIIcQQ2++kIq8vXz4X6ei6UupQJ6Pb9mVCCCGEEEIIIWQJxXZd3o+OlIrOmWMR3eY7IYQQQgghhBCSg2K7JlrpL+xhBNH9+jeXz9tTQgghhBBCCCHEQLFdg4ULuTqypwYdj+7YQ0IIIYQQQgghxECxXYe8C/kJn9vvhBBCCCGEEEKIgWK7BnkX8gzjSv7bP1BwE0IIIYQQQghZQrFdkXUu5Bk6ij6zh4QQQgghhBBCCMV2Zda7kGdwZ5sQQgghhBBCyBKK7YqscyHPMK7kn/yeZcAIIYQQQgghhBgotitwmgt5htbqU3tICCGEEEIIIWTgUGxX4XQX8gy6khNCCCGEEEIIMVBsV+A0F/IMupITQgghhBBCCMmg2N5CFRfyDGYlJ4QQQgghhBACKLa3Uc2FfIGIciPOCSGEEEIIIYQMGortLVRxIc8wonyaMHabEEIIIYQQQgYOxfYp1HEhz6ArOSGEEEIIIYQQiu3TqONCblGR+vz1by6ft6eEEEIIIYQQQgYIxfYp1HEhL6DoSk4IIYQQQgghQ4ZiewNNXMgztKIrOSGEEEIIIYQMGYrtTTRwIc9QSh3RlZwQQgghhBBChgvF9gYau5Bn0JWcEEIIIYQQQgYLxfYa2riQZ+hY3baHhBBCCCGEEEIGBsX2Olq4kGeoKDpPV3JCCCGEEEIIGSYU22to7UKeQVdyQgghhBBCCBkkFNslXLiQZ2il7thDQgghhBBCCCEDgmK7jAMX8gz8HbqSE0IIIYQQQsjwoNgu4cyFPIOu5IQQQgghhBAyOCi2c7h0Ic+gKzkhhBBCCCGEDA+K7TwOXcgz6EpOCCGEEEIIIcODYjuHcxdyi05GrLlNCCGEEEIIIQOCYtvShQv5Eh1dt0eEEEIIIYQQQgYAxXZGBy7kGXQlJ4QQQgghhJBhQbFt6cqFPEPHIyZKI4QQQgghhJCBQLEtdOpCfgJLgBFCCCGEEELIQKDYBh26kGcYV/Lf/oGCmxBCCCGEEEIGAMW20LULeYaOos/sISGEEEIIIYSQHjN4sb0jF/IM7mwTQgghhBBCyADgzvYOXMgzjCv5J79nGTBCCCGEEEII6TmDF9u7ciHP0Fp9ag8JIYQQQgghhPSUQYvtHbuQZ9CVnBBCCCGEEEJ6zrB3tnfoQp5BV3JCCCGEEEII6T+DFtu7diHPYFZyQgghhBBCCOk3yn4fHHAh1+9Hr3e9sw20jt6qM7MLF168eGtfIoQQQgghhBDSI4a7s70HF/IM877ThLHbhBBCCCGEENJTBiu29+VCnkFXckIIIYQQQgjpL4N0I9+nC3mB+ezChf968caeEUIIIYQQQgjpCcPc2d6jC3kBRVdyQgghhBBCCOkjgxTb+3Yhz9CKruSEEEIIIYQQ0kcG50bujQt5Bl3JCSGEEEIIIaR3DG9n2xcX8gy6khNCCCGEEEJI7xic2PbFhTxDx+q2PSSEEEIIIYQQ0hMGJbbhQi5q+8ieeoGKovOvf3P5vD0lhBBCCCGEENIDhrWz7ZsLeQZdyQkhhBBCCCGkVwxKbPvmQp6hlbpjDwkhhBBCCCGE9AB19nd/hFu1V67VXXE1+uF/HajoA3vqFf9X/+o7e9g7dKze/Ovloyf2tDamj8bqMEq1f14JZO8olUx+fPUf39hTb/jV5S/O/RR9cC6Zzk2/jePYhIukKjXnKrJeNrl+jbGC77GO32o9f2te0+rtv/72aILjIfHLT24eKqU/Vyr+lX1p0Gid/mAPpYOoRd+IIvM96y+z0ejNzy/+D6tb7IhfXP7f50ez2XV7uhPe/fVPX9lDQkgJPHdns9GhjJOxfYmQvaPOXrz5WinFmGHSKdM4vtBkEXj20s0vI63ueOn+T7xAa/3m3atHF+zpTsGDfTo9OA8hrVV6Xmn1sajoQ/mvc1pH5133W3xW+fsTEegv7EvjvgosGftPVaQYYtMQ9BV5tr/RkX6L/mIMOfNoMkTDTVfAIBQn6rk97RyZU96+e/XwI3tKCMlhhHZ68Ng+NyZppB+02eghxBUKYkY65j17TohzZLH3zSie3vjhxddmF6YKpUmTkLVg8amVPt7FAzWzmBsviyj6VPomjJQ49gKMMxH7IrrVd0ny87jOePMRGoK7o2S0GXMXqBkU24T4wcY1o47u//jq4bE9I2QvKPxj3PXi6CkXNsQlWBhESt999/LRfftSJYzbuFKP2R/JaaB/yYP1Rlcu5Hh4z+e/ONJ6LvNj/Jm8n/Od6i6x429sdjW1+ia0Hc2zF299T4+W3QFjjXz7Ts+jMXe/q0GxTYgffHjx1j1RNF/aU4NO07uj0ex+6IZnEj5GbGes66yENGSSzvWNOou2hbg5c4d9kFRgnMTvr7l+iC7jhEVcy6k3u9YuWBgnoidap9+GsJP54aVb2h6SHWNc0CP1zTSJHzAGfDMU24Tsn7KH7uJZ150hnpC6FMQ2WOwqxk+5o0Aao6P7SfL+bh0hZBctj+WwVwKHuMXu1tb2ltjE0jU8io76KLBPRcYpXM59XJAg8dRBmr62p2S/jHWkvx3F0yfcISpCsU3IflkTCjuZxvE1GgmJT6yIbbAx9oGQU2hqTfzlpZvXlVb3aOAhW6jtLbEJGBWVij/TUXSd/U4Q4Z2m+mtf3IfN/YnjZ/aU+IL0E+52N2ddaATc99+9fHTNnhJCKlLeHGySH4iQXbBWbGcweRqpwXgaxzfqLMKMUWd+BiJ7p6VTSIA08JYok+1ii4jDnEYPivWM00hE954zuMIAF0fG04V4iNbRk1kS36XorgfFNiHugAdUVloTMNcE8ZVTxTagey85jcytt66LIZOgkSqgf7XNNr6shavUF+xvNdjjLiYNvWEAoTiLk2OK7mpQbBNCyPDYKrYzRBx9peL4jj0lBEwire7WcRu3u4tfRiq+XV50EFKitrdEHmPQidVt6aNH7GvN2YegotgOC2T9fffXP31lT8kGKLYJIWR4VBbbwGTqZYkwsqB2NmjmAiBVaOotkZGJbPYzt+zSdVhEyWMRJQwvCQtnORX6yj7FNp6/KGWYqvScLPzMNegoeqtS/WYX1Qnw/tPpwfk4js9rlZ6PUn1Ox+oN3n80mk12EWdrjf2HSiXnytfQZRtk72tPo9lo9GbTPJq1k1L6nKtr2kfbN/nMOK5bwSb/Hlqrt13MP3gfjB20ndLqY7ymdfrDLvoO6Qe1xHYGF0LDJRNCsjhoUDubWe7J6SxKDsXHTTJkm5CXWH3BpGcdswP38rOXbj6lsSRQpH/8+OrhsT0jOXYttq0Y+RKVFuTZLQJu87yI65C581vX+Rrw7K+cjLKDucWbNsgnfCyNESM204PP40jdllMjHvEsfPfq0QUcN8W+7x353Idb2n4s1zRxOW4/vPjvn8ta8ak9XfuZs/sip5lgnvz48uEVe7yVctUKl2Npw/VtBO/NkBqyidh+r8W7Vw9vpJG+YU/JcJjoVF+tI7QxYaF+Ox40Wx+0ZOiMR8n0Sl2hjQfuoo+pZ5GKvmQ/6xhpYyxw0Ob2FeeI0OY9DBXpHx9euvUMc799hewBhGLM5mdeQ2zJ6TaxhTEHsfdY7t1zzKn25VbgGmBkrzwv27kFGzourgGJFmfzg+d12+DsxZuv8bv25U6BIMZ9sgkht4q6KsDwjPuIdZecVgmjOkLbwxi0i8+dfebsvixe9YNszVr3+tB3un4uknBpJLYBLH9J/B71Huk+MQR0dF/u99U6LjqY8OfpGSOA7EuErABvCR3p4x9fPrxaNywBD7bRPH2OPkaRvWM6XJxprRmqFDaymD54jmeAPSc7AvOi8T6M1pfTNN5pMJwvvq/jEHNq23uX5V3IX4OZ67XGzp+8v/m+ic/zWabrkrUBBGyTsEf8jjE8dCycMmOEy2eXaXcYnjeIxNw9WAHXYYwNv/tjZ/kXuvjMrlgYZ868XreeWI6bSGMzYLyx/8rvUnCTMo3FNsDCGAtkLJTtS6RnmAlGq2tw/6kjhLZN+IRYantLAFjGM0OOjw/tobBcnMnCljuZJI8RLIl6jrFqXyIdgzFo8qKshvlN4I2YzvWVUfL+Alx13716+JF8V3i+I8Gd/TkDxjWe3013l41Q12qZUNcIPHkPM9e/emTf33xX0zi+YK5BR3nX7W+axt5uagNzDcZNXB+jHbBZtPz88poVUUUgnC7d6qTevxkX0kb551dB0Gn99eLV6mw0cEjbZ58Z93217YvCETu6XRhR8ZnXXZ98M59ZrvPbxav7QaW6EGaw7DNpenU5bl4+uibfs36sTN9ZfIYTYIjmvEdyNIrZXgcmV5YI6x2snU26A94SNWtno3/N52fu4GFmXyIegQW9i3hHWeBqe0h6ABarTCIkYqPjmG2zo5abG40IqJhsEms4lUR34A5rXwJjCAt7XBkRGoXqNRAkVQyq5hpidVtE+YOmYrvcBpZKyfsW77+aBFja8QnCJ+1pbYzIzMVs4+9JP8B7GEFW5z5twrZdOVyv8houE+r21AAx3jQGuRyz3cVndh2zvVi/Hjy3938sfea4aj+0RpmlwMbng2HDnpKB40xsZ2yY6EhANJ0EjSWPtbPJFtC/5KF+o25sNvtXMExkkXat6SKtvIAi/YCCW+awDsX2GkHXaJ4tiwbsfNaeq3MJDnEd2BVsKqjqsJKUS8Cu7mg0u19rLbMmCTB2hpsaANbeG9sPcP9dJNZCjLZ8O9nsKiUkq8Ka9mtkbAHr7kWGfP4n0idqeUuuw7XYBmadIdSdq8xGQHrme3tqaGOsIP2ilRv5OjC4MSlticch/jLBAxpW6KoTISaZhZEFcTgUQuRUxrMkrpUEDf3LLN5Mkj32rwAwMZ/ZoqUubWI1icfI8wG7b/aMOCa/k2zQ6YO6IhmgpKc9NGiVfmEPKyNriMI8vQuhbVAa2bzzjEU0fVX3/e0udkFYW89NJ+QMLuNRPK3lPbgOI2yLXqUTeI3Z48qgv0Cw2lNw5CJRXYmxC6HdFRDZTYyC5vPoqOC9cTDXnO+IwbnYBrD+IaswrFf2JRIAmGSRBK2uEEJ8FLwZyhZ7QjJgyZf+dYyFXJ2FBQSbcesqujYSz8FcAOMIXBPtS5VBLVh7SHrEok80jwMmm7FGjBMXVuzwici0p7WAaMhXm8HcW/ue6ZPEubjvu8hwbQVnwY0XbsD2tDbwzrGHGYcu+252fU5EZ8nIIH/3RtO/C/GPa7On0SidO3v2Ov3MXqK+swcGrecU28TQidgGGEywDmKBbV8inpIJIbjf1JkEF0LozGsKIbKF2t4SwAg1eksEjdz3e3DJtKeV0Crl/e4pEF4Haepsh5AsUEnO7VtArWh72IiDeFowuNcXXEXRobTMAw09XaqyImx02jjuG8AoLGujwobRaDZzZzRoeX0Z2PCQb/m2nbT5u3hGyzjN//6n9nt7lL7r4jP7yjRRxc8Wq8v2iAyczsR2BhbYcCuXw94OsMBh7WzSGU29JUzMXClrKQkTuYfXEU9oF4WEHInw6qy00EApCKJ5nLSKjYfgyu9uRqmuNXaT5OfC+2Met54uTzsT3UoV3N2VSlqvOeUZVDRalN6jDbPRyInn53z+i6KhxUVGb51br2vl7H7N4qR2WAMhfcB5grTTwAN2Ja6I7I8G2aDhrsas82QbZqGm9N06RhzA/tVfjAdNqrfW6l+XnIj0jyEmTOsqQdrZizdfZx5AyJczS5JGSa3yjNL5vcxrrck1QlRDYNvTApgLZPH5ROv0W1d9oNy2LpJTwUCYT3qF626SYbrcFrhHKB1lT1sBDzAYpu2pqQjR1tiSpPMjlHS0p4jj/6jOOhGsSZA2Qekse+yELhKk5THrkTg+D28rpdXHopiqrEuWxgnX10PCpfOd7TyIIcIuN5On7RcjhEyGUdbOJp3QqHY2Hs7sX/3F7G4l0XZjq6q3i0YCRcVrMxWT+uRDbXAMAdL2KxPaQI5rj0mI6Hzsdx4jipHnRQQoyvzBU65tPHReaGON6SILdHmHH+/hxEOn6KbdDl10VYZIXnc/63zlhTaYTg9ah/ZIOwbj3QrjCLyx4kQ9h8HAGDMWVZYgpLd9EbLCTsU2wK6GseiVsvaRndEsGzTdekkV4C0Rv9+6e1kGhhwdaexosn/1FLObpeOv7elGmizsSXhgrMPbzZ6ShuwoPKPRe6DmPnZFZeyf7jItQgYiD+uMJqK7/DtKKWcbOtJPnYtEpd1dXyjGSRXlwhI8BWMJpe+sFwKN/sQZOxfbGdhVhRtZ3mpIugPtLGKmeTZounWSUzDjuIG3BDCJ0LS6Q6Hda4y3QxUjn9a69S4KCQQV33aZ4XmI1J1vdw2uD8lyf3z5UGENIi9tdHHGOgOiu26JuA+inwptIM8jZ0LJ9/nIqXDfgBqAtxGEtqmss7o7PTabg/KF/gtvjdO+7O8QUmCnMdvryDp43mWJOGciYuZu3d3s+fzMHR1F1ymCyBbG0zhuVCu0HG9G+gd2terUVc3Hn5L+g/5h6xr3nu5itk/+LgyfMt6cxAPncS3qUQ4sjkzCsRXX2+wz1HnPcts2iTMuY9ZBhZjtZrHWK/HrItxgmLZnrYALvnVxNmATazSaOd+Nr9uWKzHbDj9zhsuY7XI7ChOUUKvjpbfSXxizTSx7F9sZXHR3AwY76ibWmSgxgeWToxCyDiyI5GF6V/rXkyaLmjUPN9Ij0D+00sdwJbUvVQIxnPaQDAQXyaxCoCuxjfhS+bbczQ2pPbGLrWJ1W9ql4D1X1whTNtIhP1DbMlM2YSfaNqNRkq8uxbY1WpzEWHcgapsQmtguJxkcJdMrddc1FNtkE3tzIy8jHZIlwhxiFroNa2eP5ulzCm2yhUmk02sYt00eSIjNo9DuNSY3RF2hTZfiYXIwT2/bQ9IEXXTNrl8Xe38s8vg8vIH1in0po9ZnkDVLwXOvXHu8CUrp4jWU2tkHyjXR4Y1oD0lFsCbJG2rQl5psILhIJEf6iTdiG2DShdVQp+ld+xJpxgQLXQghe74VTDasnU2qgB0HJEFrWrIF4QnlXQzSHzB/180NkZFM55x7BggFQlvUd/bAIGLBWT3oXYH1CnYU7Snit8/VM74V2wB5QNoY78zvqrhkBCq9hwdAFJbbrW7M+9CZzUal9mp2n1eMM4RYvBLbGSwR1gK9yAZdZ6GLiXmennnGnUZyGvCWQAIQ7EI0sfoCkwyN/ayXoH8gSR7m76b9YwiJeMgqRiBcuknB3RDkYymtlw5DzPRe3p0ezWaVxXK5DdCnEA5nT2tjQumKGw/jOnlvdolWUWGDCiU0sYFiT8kWyjHuqKttDytj2nvFOEPIAi/FNli4Fj26gF00+xI5hWyhi5iYOgtdEyvP2sZkO43cgvMwL0OvGSOhUdvFqI6ZGG2o2GRZpCEqigtu2CqO75i42QZgrm4j1hEm1GRXWati5u/ZaFRrw2WlDSL1uTHw1sQ+q0ou5OqBPfIOuJKXDQ3z9EyjOvbYfJHP/3RIYn3hHXBSGamuZwjayiR6LhpnCFnirdjOwC4a0+lvpVntbJlQIX44QZBTWXhLNHILzjC7VlrdsaekJ2CBgljLH18+vNp0NzuPaljPl/SCI8bsN8fs7Ea6uAZQ+qlJRFkRrAtMOBnWBSLWm3gb4HdkTXEduV/q/L5xfdZqGWeNuaVc0msb69oAnwXiv4p4zK+L7EsLTHIvP3e1gZl79co6+Qg1o+uMqUUiN/VMPv/nxttxQEifze9uw+BQyUiD9kVboc3sS4Ss4E028m1gErSWutZJL/qCscQ1zAbNTNBkG+hf8gC50XaRgUWUeYDTqNM3apdG2QYWxVio21PvQDz6bDTaqbcV4tjjODYL5lSl51S62P0TMfSpfOvV89Am9aycayQ0uspGnmHXSes81SZppB/M42RcNpridxCzqlT8WbnUJ3ZL65S62vD+E/mMX8/i5Jt1Btvs/aVDPy28t4w1hKTY08psagOzXtIpdqfHcBvO1kzL98dYUjGyopefUxOE5rUxJnaZjTzPxnWdvF+a6q/XzdX4/NP04PM4UnCBLvYb4y3Z7PkfXDby8j0S8Pek3x7XGDNo32UbuhzbJGyCEdsZ1r2Hrqh4gKXpcdMkVSsTISEWI7JVNGlaOzsPHoYmu/3qAoYEjPSRWrWzq2J3lbzdIZBFd+vava7BGEvS+ZHS6lMZZ0HHPfd9cdq12AabxGYevKeMM1zHORnL5zfMz3gG1PZogvs5dsXtaQHj6owdRK3MGJL3PS/vL6Kl1CYt5xfbBqduzmRu11tq+o/h1dV2zO9KbIPT2h9k90Duf/a5V/oJ1gBNyjbmCU1sgy2bUGatLe0n7abOrRkzZry4vB7SH4IT22CxUxY93TJJ9pauFrp9x/ddM4CHnCmp1dCI4hNVFjw9BTs5b0T8vJEFyz+jVE+0LC7nB8nSLTI/dtFO9jD6KfrgXH4nU+s5rOe/kpn6EA/5fc95LhZhpwG3R/nmZX/BIrXOLt++MO6POrod4vMR/evdq4cf2dPesQuxndH0eWefQQ9Go1ntso4ZEJeiYuX96/dBtMconjZOwpmnqQefaYOGXoPr2KXYBm3aXxinc5njW3oshSi2QcNxM842J+QZpu1rnY1tEh5Bim1g3DjmZ16vsS71luwBIIO3t252XbLywPMTU/7OHgfNgEIVJvJUHadKv0Cimq6NYFjEGBEex5/J6cbdqw5YLijsuXPOXrwpc7q3IjGosWliZ3V4OTmkj13oso/tk12KbWBDeOAavVU8YH0hC8In0yR+4Kr9reCCe3IVA9rYuo47NTRb7yrs9H6+bSx00QZg12I7w3qCItnXqc8J87kXHgcPXMWmhyq2QZUNvU1tRrFN1kGxHQ6dL3T7DhafcaQe21NfGSPZlD0OlpUHbf9AGMe3WqtvXMYs18UsClDbc32soROMka/lTldVPBfbwY3NEL1LZIHa27htGCBlJV4cp0q/2MXnzYx05kTFH8vi763W6Q9RrN7qeTTueh5b+/45z59dzKNmxzdWh/KeKNP0MV7LrgNtcHAwfdPFHJcT/AZ5v++68g5aB+YBxGWbfA+lz432z8ewuyIz9NjTTj6z1QEnYaWOx5IR83N9aPptrs/KGH67ybCeT6ymdPzG58R6ZHdI3wmTASzmT9DR/SR5f7frhW7fCSHeX4TNE2Tgt6dBYhcWvYvTNqJT6bEsyu7uU2Bvogv3YWO9d5Akryr5XQHfCHlsisg4NY7TK3a060cIIYTsAu9Lf21Cq7T3NTkXO0r1a2eTDcCa7TmwnNrDIIGleZTOe1VOzoxD4+Kor8IlzEehDWDRR0wxdgbtS21xUju7KjDS2EMvCXlsIqtzKCU0danWMiGEEBIyQYptLOjlidz3pEu1a2eTLVj3KZ9B3K89DJLZbATvgT7VmzQiG+7DvorsMhDdyJqNeDH7Ui1gXIBgx2fepZEPieHsoZcYl9uAgQtn0z6xU/r/bCeEEDIgghTb8/kvjvoaq50tdFFugvHZjlH+72zHOg5292yRATVexmgFDjKyXglJZOeBSMYufINd7ondwd95zKzyfHzqWAU/HyPLs3zzuj/j2W4M6oQQQkgPCFJs99iFfGLKPslCl27jHaB3mrm5EVrPg73viAkN3Qi2DN0IVGSXwVwCo0FWU/ZUkBsifr+3zy1i1mv34ZANYRl4rqAWrD31lun0gK7khBBCekFwYruvLuSyyH+ChW4f6iuT5sxGoyB3z2wGztDH5U5jlHcFxPMomaJk1VoRDQMD4nn3nRtClbM0e0aapr3wNILHlO/u5L57ORBCCCFVCU5s982FPFvoIsttnYXu69/84egfv/3983988vthZGR3gMclhZaEGDpgDWBhZDreAOq7InSjrx4l+Fw/LmpEl415JjfELsvQbESry/bIS+YHSX/6Rqof2CMvUSqh2CaEENILghPbPXMhr73QfX358rn//u2Vr/Si4P4hklG9/u0f+pSQqhN8z3QMKrn6eohJihaoASxzG0e25r4K7Txwj4e7OD63d7khPN/N7FMODXhQ+TzfpCql2CaEENILghLbix00/+NuK7GIj6y10IXQ1tPkcayKsbE6ij6zh2QDo9nMe7GtlApO7P3yk5uHASdFmwwx4z/cxeEu71tuCBUpbwVWqIawU9H6a3vkHb6HFBBCCCFVCUpsL1zI/XcFPo1sJ61ufCTcxvX70esNZZW4s70F35MvWYIT23GiwqypbZOB9Wm3sg4+7uKLoPV2jIZoCNuGUknwCQAJIYQQ3wlKbPfAhbx27WzsZv/jkz/ci5Lo2SZRg9dff/L76/aUrCGEnRKto6CE34cX/x1GnuCSoiE5VJK8vzsEt3HijN71lST52d9knCkTpBFCCOkHwYjtkF3Is/hIxEvWchv/5N8O9fvkmQhFZHo+Fa3Vp/aQrCOAxZvc57AW9EqH6D4+Qa1hCm3/8NlrKTRDWBUwBoynlY/E/fMkIIQQMkyCEdsBu5BPdKqvIj7SnlcCO9Vap8/kM1c1MNCV/DRU/LE98pZU6Rf20HvO/u6P2NEOalcbcbdwHafQ9g/fExgGZwiriFLry8HtG93T9iaEEDI8ghHbIbqQa1s7G3Vu7UtbMW7jv/3DY1kGPa4TC0tX8i0EULc11nE4C8xYBbWrbbxL0qi3pb1CJ5nOvR6fWul/2sNeoSPN8UAIIYR0SBBiOzQXcizsm9bO1tPRcxHOjUQzs5KfQgD9J03TIFxVkYF8Q6I+L8F4lOu9UcfoRXaL8twYxp3W3RKU4ZEQQgg5hSDEdmAu5LVrZ4Nl7ewoav45tTrCzrg9I4ExP0iCWGCqgHa1M6E9tPJeoeF7tQCKv92i9ZztTQghpBcE4kauw0j+1bB29j8++f3Tcu3sJpjfnyaM3V5DCMaaEMpQ2djaYPqYiqInFNr+I/fJayPhNFH0itghWjNBGiGEkH4QhNjWkfZ6cY/dsw5qZzeCruSr+J58CSB5lz30mtFsdr2tUWhXmIRoyfu79pT4jFaX7REhwXj5EEIIIdvwXmyjlq/nu5Kd1M5uCoQ7XcmLiED0XmxLHw9jcalUMIkKtYpYSzsUPI/ZDsHrpC/AeM32JoQQ0hcC2Nn204UcC4Kua2c3hq7kBXyPBwXSn7x3UzWJ0QLJnSBj85u6eRPI/lCR8lZsh+J10ggPE0cq1b+a5oQQQoaL92LbUxfyXdXObgRdyYv4Hg8K5Bq934FVyu9wjgxjCJtHdB8PCBG03hpxgvE6qQnCa3w0noVgeCSEEEKq4rXY9tGFXBYCO6ud3RTjSv6by0HsQO6E1P8a21qnP9hDfwnFhVynD1jmizikl2Lb1/CaEAyPhBBCSFXkueYvH168dU+usDt36xqY3TKlj+u6ppokaEn0WBp6twubVB9f+M+/1Np57ytnL96CkaNR7fJdgbrsPrs9w/AVKf3UnnoLXH5HyfQKY7XD4sNLt7Q99A4YWN+9enjDnvaGs5dufqkidc+eeoPvc2EbfnX5C2P4nU4PzsdxfB4lzmaj0ZsPop/ecs4iZAFC1jA+7GmUJD+PhzQ+zNys1cf2NJom8QPmsTidX166uVzjo1Snb1VovN7Z9siFvFHt7Nf/8/dftq6d3RCtomASWXWO58mXgO91fLVKg+hPTIoWHr5XC+jxTquX+VBU2p8YeYjrs7/745F8ffXhpVvPZ/Mzr+fpme/jRD2H8VLF8bODNDWvweAki+ynWGhDbNg/QcjgMCFrMO7br/n8F0f2v4bCp2aj0X4l07n3a9h9o7S6F0fqMb50lHpnRPZWbPviQq7T9G7d2tnAuI3H6t6+yiQhLpyu5BYPkwCV8bmOr9mN0cr7hx12tZkULTx8X0ikSr+wh73B5zGNnV57GCxWZH8FcQ1BLV935OXDbesBhIDB2wBiXMT3s/xuDSGEkDDxVmxrPd+rQILbuCxGrr3765++arRTpqL9L2QUs5KT9sxmo62LRC/Q+mt7RAJCee554rvXSROwU+TpmJ6E7C55IrIPnkNgt2zjI+zSYEccu+P2NUIIIYHhrxv5fpMxjUfJ+wttfP5VFF/TWu91t1LH6rY9HDQ+Ztwt4/UCM+42e74LYBwbjWbMURAgIZTm6xu+hoXIOA42sSGE9iw9eLwQ2U779CF2x00OG0IIIcHhpdjelwu5SYJma2e3jfu88Lf/N/n13/9yBYnK7Es7B7HiQ3cl9z0eFARQx9fL2M480tefMFY7TOTeeb2z7XOIRxN8diFXkfrWHgYFYqzNbnakuvMmU9GX2OUO4ZlGCCHkBC/F9p5cyBvVzt7GIiN4fEVH0X4E1cBdyX0tb5NHKeW32A4iXjsNcpFOBK0u2yOyA2az0Ze+hoWEaNiA0FaxelZhg0DWGOld+bqazvWVaRxfwBfOEbIW6ei+CV87ncNROmd4GCGEBISfbuQ7diGXB1zt2tl1MLvcf/vzBRHcO3dz1UohMctgCcFFVfqft2LbLCQ9j9eGZ8C7v/5pbE9JaHges92nkitmV1TFvoYXBRevjfZUqDhy+hw5hrj+8eXDK8gBg7kKaw18VnzhHCFrP756ePzu1cOPIL51pNeGsGGt4npDgBBCSLco+90bdlnP17iNN6id3QZTd3v7w9kt89mFC//1ojcLxjr4Wku2gI7uY6Flz7yC7dcdcOf9KfrAa6HZhqrCCeWOOnW/bYEx5Lx6dMGeBs/Zi7cey7PHzwzXgY1jjN95egZrlbWeP+g7KoqPm+Z+MUnRlJL7tTQYT7ApwHAZ0neQZNBm8F+g1TXf6iZ3SfmZCGNdV5uBfUGebd9nusrH57Z3O9s7dCFvVDu7LRf+689jdWZ2ARZq+1L3DNmVPPW/xrbW6Q/20Ee8j9eWDv6dPQgCLNKR7AhlgVBjt69fZy/efG0/8ul4XJpPhE5vhM0iF4qnQtsQ1jiGO7582xRiI+uL5GobgYAd71EyvYJdbmwMyIL7BoU2IYSEh39u5B27kJvd7EgfN6md7YoLL168/fXf/3xjV8nTBu1KruKP7ZG36NjjmG3Pa5RjPCfJz8G4kMPtFBmLkexop94tewA7cj1I5tQLcWOSoint9XMgpHjtRXtudMfHDrST9QXE9buXj65FOr3GnS2yT9DnmZyvGVnbsf36A+6peQ5UxCs3csSHxol6bk+dg4W5itQNn9xRXn/yb4daz+Eq1q2oGagruc8uqks8dZHCgwE7lPbUV8aoHmCPvWbhFhrvNoRkz8i92fqM+fDSLW0PvQMeSO9ePbxhT4MECwJTksrjeRC7t0ZUBsKKm6sF7ovY0d6XIb8J6B+ouy734DOZm2Q9EuUEgX4rq8RJlOoXs9HoievPZZ/PC9dPea91fcD0X3gRqPhjuT5c2zlp53PZdSmVTHb1/LRj6bpc82dyKtexpq2i6LtZnHzjuq1knnxmDzEvvVk3L9l67EfSN+GRdq5p2MGyT+g5ys59hs+Zf26hn5vPqhXW1N+6bv/Q3chtnz1UStou0ivVlbL2kwfft+u8a3fhRp5doxyiv8g9hheoOof7nF2f0uoNks+GkBOnazfy3NhaGQ8AzzCMB630d+vuqVdie9MDzBFjWJt9dcP6799e+SpWnX126QjR/V//7c/BxbW2Ba6s5YnON5CR1sfFGSYXGY/LB7yXBBDnuVi4nLkjsy3cTgdDlQee9wadQPMBZFhx4LXQNgS2mN70XEkjfWPXoWlNMWNvnt6WtcH18sJxE1hQipA8dvW8Ki6Qo7dIEGf+Q7CbL/fk9a1JOvG7XebfMdcSqy9qtZWOnsyS+K6rtsobJctzq31WI7dKYdOm7toie1bV+ZzA9WcNWWxvuhengSoFSJ5oTzsV21Zkw3h1u8Y9nsjc9sDnua0LsZ0ZJOreT2GlvfxyI+/AhdxMwo5qZ3fJ//j7cxloHZYI0z7H6hEfCSGTu0waXsd5YpE2T888G5rQBiJGts63yXReeUG3D1KlX9jD4AhFaOMZHVIoyCL2fe3cOA5FaMti/svRPH2OeamOqEJfgnHsl5dudrqewPWhnJocHlW5PvxMHKnHSACIfm9fdsLyWuq2lYqu766tjFG8sXck2izLI1L3c4Lss5oExwMFbYj+1+RewLCQ91zoCqxHZvOD53i/mvf4EONrF9foCzCaYO3WcGyZ9kJ/sOf+iG10gg52IDupnd0VXZYIw8B6/ZvLAYgnt/i+qw183NUGKqr3wN0HPsd55haMjRdBgbNVbCvPy37FOvbWQHsay4WC7zvaQKcPQkr8tTGJq1YP7JHXmF3DSN1bs9ieYIcSu2zYScQmBTw75PUVQwgWkl2JSDNvrr8+Y5ixh2uB6DM5MRwBAVq+FnsNi7YybbRoK5zL67ttK3sv7WljFjudRZFtP+cY/QEeG1k9eHt817gal5B2cG7sCIGlYXNNAkq0o7TLN+gjaLuT9ltJknwkYrazMNrFjrt6tmZNPDHXZ+9zdn3y+tj2gTy4xt4LbuhRhPzJYWGuz9/LlfEAN/IS6A+ZAcobN3Izabh0IZeHRJK8vxvSQzxPFyXCMLhNYraBEEjM8QT1V+2xV8iix/t49yoxwbtm+eANQeh0COabbfHOWIRiMWpPvQMP1BDi1TLQ95q4ge6T0MrarHMhxyIM1U18NZxmZELWnmagDvjxaffAuFEnZpwWFp9t713ZjRybIwtBcPIajDFyOJ6NRqYuOV7HAjZV6TmlozvrDOouxq3rtmobLlZ2I5d/bthdN0PWVibh6jyaHBxM31Rd/65ZK239nABtJIKjsEsK0dE2/8KKHvDcjRxGGRgr7KnB3A+l747i6ZPT7sPK74p20Uqfz68f2o4zs5mZG1eg8fUBD8OrXLuRW8OHGcNV22rd2Mfv4tngjxu5IxdyfDBYGtARQhXaYFkibI21pAWDWvz77qJq8baPymTvu1dA44dPV8B6bNy0Bi60gaqys+259wQW+PbQa4wLo93NxsIov6jyGTzf2iwifUHae+K70Da7NSKM7KkBOzLIZbPtHuD/YRTGjo59yaDiCLs/zkCM9smCOXoySt5fQCwrhHO+fSG84LKPBTU+g335BNXOgGd2o8ptJZ8d4YiV26p0XSJmHRoV1TkRo3lDgClli7ZCu+Aa6qx/0bZobzmEyL5S5XMC4zWq04KwxrMP4t2e9h7TV8piFLvF1qt2232AVkGbLz0FMH87XHvh2QABWHomLPpLk+sDco1mPukx8plvQE9i3Jt5qEJbYcwgKWG+rdDuo9nsuhdi21hd3Lj77qV2dleYEmF/+8s1VyXCcNNf//YPwxEBSdGy7CMymL1doMmE4fuCvfJiomvwQFtYgJFt3HsjxU6oFO+s1WV7RBpgRfZXNg4vuJAFpeOv7WEwrN1J9Xgez8gLWYOO7kOc1RFlWHDmNwDQFq5cpO21mbrl2DCBV0yVa8NnwGexpwZzXW3EgNLF5FFoKwjLGuC68m0lHLmKabbXZj5fZgRoa+xBe1cV2XlgCCl9zuhgrnstxApIX7FHBggtCK467YifNTX1sYO6wFn7TdMD9Lnl37PXV6s0ofksWhe81FQSufNE9hB8ZiRsrCKy85ifLbVVFKvLXohtpXSrCSizPtTtQKFw4T//IpN8DMtSrUlwHTqKULJiEIQQc1xl928fwDLtvWjUfuxsY1Fn4gQD2lHcBZXinT2P2fbteZLtYMN9E7FzSGgEd8sQDTxm0RdQYjSwaceu7jyO+4fkOU2+mohI9Bn5ZoSsZYIwO3tci1E8vYF7Z0/x2Z2uKSDc6m6Y4LPkrwmIGMh/3spYQdxJW8lnc95WdY0AXVA2mm3Ma9Az1vSVSKuoUfgqfkdFynmYZxyppTHAiHkRgk2ub8WootURnkf2jORAW9nDBdJWMk/unzblmdB50EFDKhvShrYlwtBev/77n5flNfoMdnwKcT8eAiORDw/LMkHEu3sQN4SHrdzDsosWEarETYro8DovAHbYEP9oT3dGHMfmeahVar4rrT4WVXMk8/dKfc9QQduG5oWGxeU8PfO9PV0i96VWPXabZKiRGGwSj7zyLGwZA1v+e0n8/qMmC/izuThLgPUJXDYb/a3SNcGNW9ppWU6pKjBoyDWd7Na3bKt8zCs+H3bLzH/UJB+zDdq0lWvK48IaARrHbbvur12x0udafm6QjxXOaBqzDcNcnKhl0rW211e+zz7N4fm5BAYuF6W/2lC+j3vf2W7pQj7GZDMUoQ3alghDZ3z9ye87yYzpHSr+2B55i9KxVztnGSHEu2ud/mAPdw4eOotFlHaaxLBPVIp31u7c5boAyduwWNn1F/qV6VvIhIwkTYvF+tZ6wwERTJmsPBuFjeceGvLgX+bEgUhr61GgVFJY+KMWrT1shYqiUxMQnUb5muC6aY9qopdGEBdtJVe2LE+J8dvKvT1Hm7bqGpmzhvFMLOWachIWo1UjL4p1lL2G214f+lveUyNmGNhGdFT0tNm72G7iQo4JUD6I97Wzu6JtiTCt1af2sN/4vgAi7Yi313HuAiyWskRU9iWyhj6G9BA3rE1qFQhYf9jDE7RqtEu9C1ZCgpQet103rQjQWDkymp0I07qUr0kEX+1NnF20VVP39lWat1UdYFjGM+8swlc2fM3nv/C2/3dJeaPQRSnS9sadHCWDk5tSqWp5fciabg8HQzYetn3ZH1+ydzfyBi7kE2SJa+JS0UealAjDYmEIruRtwhN2RdtyIF2BB6jKlRXxkX24MK0rdUJWqerGVXaNJP3HhavlPtnkAl5nLt/0N6pQ140cCz/jLWFZ7EydLJhb8Hk2D7Zw2S64kbd5HpZdXIXaZTXLbSWg1nDr57N8xqU3YdO2Ks+VXa0d7LMfrtHn5LM3DVsZYzPMHtdGrsF7N/JyqJ1L1+XyuGjqRp5fA1sjYes2lOuCkDRiEn+zaViEa7pyI8e8gjr00h8/k797rqmm2OvONia2Wheuo/t1s/z1nSYlwtAhB+NK7jkfRD/tZXd2G0olTR6wO0XtMAEeJlwbX1zM6EvWIvP61n69KdkU6S9YnOl5FOyuNhCxtHZHcZTOK3vpyeL5GKJ569e6XfSaqJKHF9ZcMoehDnvbr5O/6yBkC59134bnLFdCjqM1n7v2l/1bzoCYcN1WENmIM7VGdhiC+hS24pyVUDvlLreHtLtzjYN7mfXHNl/ypxx5sfgN1nwIFcySkMpLrapm7VVsV3UhxySMXazQa2d3RZMSYXoAWcnbDIxdgAemr/05VSkfshYsQlg7uzZb+3UgdfCJQxBnGrqxfDSarQ/fKtVlPg20AXant33ZH29FCIbTIaFU/Ct76A14xqFspRyuCCljIDNf+s1pX/bHiQN0pB2tCwcSO+8Y6yXzVB5YayvMNBkPe3Ujr+jmO57G8Y19WzxD4fUn/3ao9fyxtOup1id0lj67kgeRTbuBm9uuQO1UJIeyp16iG7rjVcVMuPMzd3RkLLp8aNVA5pet2Zmtu6LXoQrEKWOU5+yDwXzT2sX1nFR2JwXY8a4jxNe6Rm/YnW8KkpM1cfMtun62c0m1C+RWbuRr5iRv2irvRo7FvCs3WayVRvP0eamfjdNIf30QT7+pOl5Lbu69dyMv97e2/TdPeX5p6kYOTwX5ttQCmJ/soRti9daXajou3cjlbxUqEhjxrPXXWqtvDg6mlTbJyn9jb2J7zQOgADpupPTdUTz1NuOiz1QrEaZvXPjbX4LLCFuFbf3LE1o9kLoEsckmC7LHuF7Y5jEhLkl0h7vZDalQli0Egw5xA57nOtW9CQE7re/WFcOn4UJsuxChXeGb2F4RUB7lF+hKbJfLLyL5cBMBNXSxDZqWwMuzbqOohdgu5IbwNUeQC1yJbVM7HdVATpggfLnufS2L7b25kZ/mQo5JVwb/DQx4Cu1mVCkRJv/XX1fyxP+4Eunn3k560jf8H3cdlXbDQlrF6hmFdnNSpV/Yw43sMuae7Bc8z/sitIFNzLj+86j4KYx19mzvYA1ldmZOOGS+hPUs2ir37PM4y7wzcuUXrXHBi51K31kzrqLp9KD1uBrNZu7Gpi7OUXXySgwVrdJC+0/j2Ik31v5itkv16XIMrnZ2VyxLhOlo7e41xMTry5d7ueANYSEv1+itoI11HIDYdlvaDZZqJMTAjlV5N4nUo1L/YY3OYWC8HPr3PNdputZzA3MHjHUmDtYT5FlfaH8uuk9l2Va4lzC+2tPeAaNLIRwi3W4kXYfZDSwyiOdneVzBG84eNidWt+2RA1bKww2j7G878m00aeIJgLWkzB0Fg+texLZx0SzFO8GaCPcVuJ5wN9stv/77n29E82h9ZtNp0s+Hbup/je0qu3/7Quu5/2PQ4a4DFsZIgiZPT9bOdkCl/sM6+ENgkiTvg84+vgm4cm80ZBvBHT+D8c6+VAuIIPyuK6Of1um39nCBVnewILRnJIdWuiBQlHYgoDxlpRpKvL2KxFqUdigQwyFN9df20IANrDWGh8rY8D1na3LU7M7vvre9viEgbbTUpjK/N/IysHXn9y+217iQTxDPRfeV7thUIqy3ruQduRi7xOfdY60bPnR3CBaiLhaMpna2ip+uS3hEmjEbjbwNkSC7AYs8Vy54vmKTAG6On1bRl4hlhXCu4roNox9+FgmrXBr+bIz30qUUc+cc2XYb4pObvGsQIlAQKPJcQFyzPa2NTx4OZdaMzdo7n3bnv//u9mtAaMzqmlo3ykNi1jI1KhpUwdxfXTQI4PqahpHgGnsfgqJP5vMma0zz80qv3Mf9uJHnXchZO3tnrCsRBktXL13JA9g183n3eH6QBLFAbhMjhUnRJodh7WzHVHK9ysUKkn4BsTJLkqtDqCKCDOvy7fT1iwhnJD1CwiIkzkECKIgUGPogruX15ybBDzJhbyg305Y1bu9HuA57XBmIR7jJ2+RLvURFcaGtsE4yRtmaZIZcz9vqxAgjn7OOIcXkN9F+J1LtGj2PCp47GLsYz3XaEWNqnp55lo37tV6oDUGpwqLxKDonc9HTuqIZPw8DHQyBfTa2lT1OUZHGHm4Fa0rcRzlcaZ89xWwruF+xdvaeuPCff7kvt/6KDMDxaQnUgiaAhbzPu38r7mWeopJmFnVMiqyd3Q35BzsZHni26zS6NpRynVi/IOt1eYdrA0ey2L2OTMsmNwQqPix2sA8rCuyxLJ4bbUyY3W0dFbwHcR1GGFSIS8YC22TYjeNMFBy12fH1GeQYKIcI4F4Zo0iFnWr8TMmQe4S2W/yvX+i0GGJgDClbXI3RF0yYgwjtiv22t5jd7dWSWqYazjZjFtYhaEcYZOR0sWbFGFXaSTUDgPkJ87E9zTg0xj+89xayazTeNov5y+Sk6OsON8rd2cMFMj9vM7ShjTCHmlDENUIb7LXONiFdUbGG+16RBZq3489a6AplLXwEC9wmpVlC+XyBUqnkjixctT0kPWEhtPtT4qsuWFxDwNpTZ5h2VfrYZkFvhRWBK2LKGAsQPoSdnVRPEEoUx/F5reeH8pk+k2s4nxdWuCb5OzfaJL8zu/n2b+Lv7bv0Vxm7I70irtFWIjTfyD35J9pKqcR+hkVbyWFhwe2irfLzJQyarkp/ARgR5FtZJJga4zpWbxDylqr0nEr1efl8n8rnKRqHRCDKxV3Pvdaq7VfGkYelv8oYQ1Su1FMeM7ZS/QJtiXOTwHeRIPTzQjtKu8HTd5YewBC3HKNNS3/lgQFI2nTFw8IYx1U0wfWhBnyapm/MuFfpebkGjPtVQyA8kpP3d33aKC3OJS3rbIu4ls9eNkTAqPIt7qGMgzcY86aNtPpY7q/cx4LekPkzknnBgzrbhHSJ7wt51w/LLshPXr7SZoGGxZmLUh0+YB6OUXrPEwPT1hqrsIqXa4mSsHEhKPoAdv1UrG7nF1pNWbRp9GSaxA9cego4MApMRCzcbXuvfRfbYLHz2Cp+foLcBW3vX5diu9V8LMILHqql9cLgxDZo01cgyEfx9AYEbNkg5kJsAzs3Ld3V64IxGil918f8Wi7FNthkaKuAMZgY9/NcX6DYJr0jkIW8k4VAl2ywdnuHLGQuDMVl9TQcLAqdIA/kJzZx1Ebw0IebnT0l4QOr/7FNxEUEu5MEwVB7wZYtamXx/aSr3SOz8E6iO/lF/TZcX1cIYhvgXkYKJSGrGzNdt1WXYhug/WbzM3ALr2okKhhcKLYX2GcbQgYqrZ2yfpIXsF2J7Qy5Vxt34TcBY8AsTo59XWu5Fttgww73Wsrjvbwe21+dbUI6IpnOG1ntdoz/MdG5rIw+czBPB1l2pIysxLzo96pC31Ys+9UnxrDkU2gXQXuI4LgqXwpiQRZjcAGHe2FhfOAci0M5hNvuXSysITqx+O5KaAMs3hGCI+95Fe8rL63cv+W1wU1Yfm6UvL/Q9XX5CO6lWbzjPi7aakX42PsqAjTMtsJ1wkiK/mf7aqE/5D8ffgZjPi+ARei8QV+xfXlQ/SMPxpUxNGzoK4XxHunjrJ8s/teilfwMfm7xZV91Bu6z3L+P8P5yanJoLf5nQfkazZwkc8XQNjVwX0w72fnRtokhd29MG82SGG20HO9apz9kP4Mv7myT3oFEBUg+Y0+9RAbf1t2/fePA1XAnYCJrsyPSFzbFYu4aPHhWFg8lQhijpAIexu6FAjywkIjSx7bb1bXhfeyhoe1i3vXfq0KobVWVXX2+PNhl/yn6YGmQ9XWc1GUfbVkH36/vNHY5PtA/8b1OO1Fsk95Rx/Vjb9g4J3vmJSYjqdJhZJsNyM2sK7xx+69wL4IYo2QjxlrvKGEXIYQQ0mfoRk76R+q/i2q5lp+PJMnPwbiF6kgjA+yg0Toc12xk8LSHJDwmJuM4hTYhhBCyFYpt0j9U7P1CHqU07KG3wEUGO1j21GuQ7KPsRjQ0fCl1N03U1kQuWulB36sQMbvZkT5GrKbLZD2EEEJIn6HYJv0jgORLWs9DEbHBLKpH89T7+PKuGLqhgXSLiOxvyglgCCGEELIdim3SO1Tkxw7facxGo50kN2mNDkdsD3l326cM/JUSk2j/S8oRAzJkXx1iJlpCCCHEBRTbpHeEELsaysJ1msQP7GEQHKTpIDNc+1JKK18ag4QNyp0k8ftrLOlFCCGENIdim/QOX2JXNxGSIIFRIJS4bcuRyaI+MHTsR5+XsVepr/g+RoeOKaf31z99RZdxQgghpB0U26RXhOBGXFWQeERYJbWUfvrLT24Oyk1ZRZEv3hxb+zbjy/1Hqejc0MYQIYQQ0gUU26RX+BS7egpBiW2t9Hf2MBhUHIVRH9wRvpTS0jra6rURyBgdPCpWt+0hIYQQQhpCsU36RRJA4qWAko6Bg3ga1s62ADflDy/eumdPe48vpbRUBUOSL/Hl5HRYTo8QQghpD8U26RUeudP2hkW97QATX6noy7O/++ORPSM7IFX6hT3ciC/x5WQ7Qy6nRwghhLiAYpv0i9T/XbMqgsQ3tIru2sOwUPHTX13+ov8GGE9KacU63r6zTYNYSAwu2SAhhBDiEopt0i9U7EXs6mlUESS+EaIrOUCip9n8zGsme/IHX+LLyXYwfs5euvmlPSWEEEJITZT9TkgvkIXhUxUpr3dj0rm+8q+/PQoqbhuYGGgVBbnwRikjneqrIbZ7FT68dEvbw70yjeML22rIBzBGxzpNd5oUUMXxp/LNy5AHUwbs1cOP7CkhhBBCakCxTXqFiI7n8s3rXcwqgsRH4I49T898b0/DRKtrP776jyB36TeBJFYHafranu6VHojtyY8vH16xxzvD97GVRvrGv14+emJPCSGEEFIRupGTXqG1/zHbIQptgERp8i3snWGln/bNLdanUlqV+rYn8eUb2EuIxyIJYeStmFU6YqI0QgghpAEU26RXoOSTPfSSILN650gj/cAeBouK1L2zv/vjV/Y0eFTih/tx6H0bVKkT3hWzJPY2CSHmVeY9IIQQQupDsU16Qwg1YWXRGlxytDxwJe2DqFJxfAchByELCLgeG6OBVl7sOlbt2z4bxKrUCe8KeAXoSHsb4qBiddseEkIIIaQiFNukN/jkTrsJrQN3wxZUFB/bw9A5jBP1/OzFW49DMNRkoHY4ktUhyzqMBsgYbf9r32wVqiG1815I/fUckX52nfePEEIIqQfFNukPid+J0cA+d85cYROM9SarN0QEEoyZbOuegl3sX166eR278SKwn0lH+tIjkW2o4oLtu0Fs3zXw3/31T2OfPUdG85Sx24QQQkgNKLZJbxAhG8DOdvqDPQyadK5v2MP+IAL27MVb30PU2lf2inUTX+5ix5F6LC97a1CqYkhSyu8Ehj7UwNcq8jZ2W/gc/dIeE0IIIWQLLP1FegPiV+FWa0+9pE8ldEKoad4KHd3XOv0Wu432lc6BkJnPf3GkI/2ZnH7u2+71aVTp2zBkWKOBl+g0vbrL+72JsxdvvvY1tl365vG7l4/u29NBY8ruzXUjA5jW87daq7fzg+RtqBUqyHrQL7q8p+V+N03UxKc+lD3H7GmUpumbf/3tUW+84QipC8U26Q2IvYVLsD31kx7VeTYPfE/qO3cJ3HpVpOSeqe9c3zssSmaz0WEUq0N5j8+0jg5DEtgFKvRtlF1DNnh76h2+1MD32SghffTtu1cPP7KngwYJFpH3wZ62ZRzpaIJQBtY0Dxf0CRWrZzKPv0H1ji7uJTyeTDhRho7u//jqoTe5VMprAyR+fPfy0TV72gj7me/I33qrdPx1X9ZRZBhQbJPeEMJOqy+LeVeYOGcV9apudQXGJj5Zp//E8Ww0enPaPYWg/in64BzileM4Pq9Vel6E6WVZjGFnwvs8A1Wpsivse3/xZXwaIwwS4HlqeOmTh04bHIvtJSZuX0UP6EEQFhCZo/lchPaJVwrupU6jay53docmthftmj7Pz4d9W0uRfsOYbdIbRGgzU+6OsQ/4obmHHclD/zqs7FjwmORql25pfCHmGy7AJ1+3vp+nZ77Hz5hFudIwCN3D78vf6Y3QBjA62MONaM/zKviyePvhxddvVRR5K2aVjpgorUMg1jBPICEihIZ9mXgMDGQyzz8tCu3oLXIw0IW6HaN0vhJShdfsISHeQ7FNeoPWfidfAn20xE7juJV7WJ/AgsAslJdfgbqEd4XHCdJ8ywKeJO+9TZSGvh1yjfqAOMSOHtvab4wnSnpQTmA50am+Sg+Q9igdr8zNugeVXchwoNgmvSFvUfYR3xbzroABAUmT7CkZKJUMSdrjbOpKebV4w+621h7vbifc3d4FxoAXq2fc4faX2fzMvVII2ziJ31/ljrYbkuRnhCct2xIeAwfxlDHbJBgotkkvCGEhIov5XoptYGML957FmeyHnhiSvNspGSXvvTViQVxQAK4HRhLkMDjtCwkFEfsux3e3GVUguEfp3NvEgkMGeSjk/pjErMZtPNLHP758eBXGMvMDpDVoS2nTK2a8SPvKvHiB7UtCggnSSC/oKlGNS7CgevfqYf/qU1t8T+pEOmWMBaY93gji2u2hd/g6Pn2ustD3OW0bG587DRNWIVu/iPA7G+fQHlWz6AN45k3Tg5Md7Xk02cVu9hCzkRMSMtzZJr1AeRwLmqF6HmNkLM065QN1gIjo2rqz7fsuqK/jU6f6gT30Ee5uOwQeQojzxQ6pfamAVukX9pB4AJ55iMleftFtnBCyBopt0g9i5X0CGa3TH+xhbzGln7Si4B4YVYQqSp/ZQy/xdXzaBbyXi3jr3syswA7B/YbgtqdFtDqyR4QQQgKBYpuQHaHj/sZs5zFujjpifVhSwHfvE6/Hp1beZiaXa2OiNMcYwb0mjhvGDbgQ21NCCCEBwJht0gt8jmtcMrB4uyDuCXECEtdsK3Hzy0s3r8eRQnkcP/F8fKJuu68VF6rc/z7iOmY7z4cX//1z1OW3p0tctzXijufzX4iA15/KihAeYjCKIdHXWxkTCA3652w0euK6bKV53/TM8vPpNP3u3V//9JU9XWLLal1XWn2cuz7EAb+R1+Sa1Heux23Va6sKYvFVpD6zp1E618dtXM6rxmxbw8xRpOKP5Vl8iPKoSNSKe4u20zr91nijOaaLmG27njDzH66/ixhw09dmI/SxrM3wfufQ1/D/XbYZyL+/3N9P5fuir6OsrYomUapfwCg8j5NxH8vI9hnubJN+EEDM9jRRg4rnsomTmKF8AMQ63upGruzCwVfSNPV68aJV5G/dbc0yYK7Z9LxwNY5gKEAmbSS1NKJeRV/KyxBni8V+pD6HsVQW/XcgnD68dOsZDGb4XYcsxOCJuFiSvz65lnul6zs0pbbwmlw7Ei/iZ/F7Dtl4bXUxhoL83+t4vQKRLW3yHIIc988avQ+tsc7cW7Qd/l9E7Pcd3FfnwFgg3xZt6DicAiJX2uwr09eKbYb3MX0t32bobxD/rvJVmPuV9XX7/vKyeW984b6Za5DXYbA249F9fycdQrFNeoFMRF7u+AydJH4P6zMFd8/Rer5dbC8WnN4yP0i8TJCWgd1MX0usYTFod9FIAGChjtrdRjxUrx5xhIU+RIY97wyIv9rXJz8L4Tj0fgjRGKkYu/IQaltB++K+QpzDwGFfHgzoL7P5AQwTm6sArAFivK3ohcg3v4/7VW8smv5uRD/n3SCg2Ca9wLjZeM4Q3X5sfcyrcCOzL5EeMhuNtvZt7fnOdhDjU+uv7ZF/xOq2PSIO2JRQUOm4cT81O3iXbq5d2NsM6GO4JKP2N47XGXcgMmSRf+LC7Bi4XEP85a8P14ZnCOLYbSy7XNtqUkb8DnYGQ9ip7QLc2zWicWKev7ivtu0WL69wCAPHkMSbKbUnQndTeI7tY2ivtWPBsBC9tccDwkQWXiVrRfYiZ4Mdi6feN7l+VoTwH4pt0gs2TZYeMSgX8jKIr7IPDNJDPoh+2r4r7HGoh687xmVGo5m3iQfh5shFnzviON4gALZ7kWxilh48Nu6wRcbpXF959+rhRzCMIvYX8ck4fvfq0QX5rtbM3UdGtDsGAkSuL79TaK5tlLy/gGcIQpPwtbi2hx+JEEHW9pVnq9mBH9iOH4Rj6d6atpO2uoK2M/fVth3uKXJUlOc9I/oGIt5se90rC130dfSrJH7/0XJM2LGA13Skj8vtJufnYciyp5VIkp/H+feW930Lcb28Z7hXdizm75s1hC3B3zhIU39zoRADxTYJnkAeDI0XSH0BDww8TOwp6QlYeJga61uQhY2341QpFcT4XNSy93cMjeYpY7cdsammdhUvknWUxRgW9xAOWMRvS9aFuRsiQA6XP4e/ZZK4ueOcjlIjtLNrQxgSrm3T/IJEVRAm+Fn70glD2vFDPLOtClD1viKpHARkeT6x4s25IcUnjLt8qYrCQuyqhUFH+tW6PofX3r18dD/fbvg9FcXHVZ6BefDzOeE8Rrk/iOutY1HEtzUy5TkaqjdHKFBsk+DxvX4vkAk5iJ2zrsHDpGyZJWEji+5KIQIiyn0ep0GIbZAk730eP9zddoBxb12TBAqGrSbhDmbXrSQuZNzegHCwp1uBCJjGcSEDtIg6lztqWQKv5bVVFTD4WWsMWALROCDjzxE+L4TfLImxk135vuKZDJFpTzMO+yze4mRlR3sC74k6We3RbuhzWunjptnwIZztTvZWg1ceGANWjCSp5rzrMRTbJHh8r98LFHe2l2ywzJLAWO6gYLFWAZ9DPUIyhpkdEU9DMozASecudzsHhxE5IoxLYmBBw5j92WxUjAuVhXoTgQChn99Fxt90blxpeG1GrJQEiDAs44/Sd5sYY9Decl8Lba50wZ2/N9jwgoIhS9YjtXemAfpc2zJ8dUR2nhWja6wu2yPiIRTbJHxi5X0GzVTpF/aQCLDMIv5JDhs9aMjeGdfZQfF9wRuaMUza3t/d7dIOKqkGRIDJEi4iZ53QhnGrccy+UkuXdPydNt4RGPP5mFWXu8f4u22uDb+bv7aBGX/GdXa0y4ziKUp1LkHb9TI7uYqL4Rk6um92igPDGl1PnluOy6ERt1BsE7IDqtQhHhp4WJh4O7qVBwMe7mmkTbKWOjsoIYR6hITdYWzkutg1ZpE+9PhBtXDD3fYFd3EIbJRdQhZt+b2N5X9UFD1psvsGwVTwKlF6bTxqPdRSnMj1uhNkKnrQ5tqMAFmtR9+qRnYwaPXAHjXCtHvZNTkp7gD3A134TNMkbtVu+0TGXsGwZA+Jh1Bsk/DR/rvPtMkg23eyuKWClZb4yBhxbU3c5nwP9QjS8yTV3i4SlY6GvrttalJv+1LIvC0CW37+VMEqc+OTpju+ZcGko+hbe9gcnf7THuHanHmttClrljGPk+Iu5UB2/KaJcuAlpr6zBxm9MlSsGJ6iaNLE7Z6Quij7nZBgOYvakqvlTLxiGscXOKmfDpL4zOZn4ELJrJp+McauSdMkMAC7eBAX9tQ/tLrW5vPti7MXb772NhY+0DatAxbvcaKe29OumCTx+6tNd3zPXryFmtUnc6qO7mull2K5EVpdzv9NhATVvT7M9/P0zPf21ODiObnu79a9vjV/A1nPG+cZgfeCNaoYkLOkjesyQg6MJ8QJE3iJ2ePGINznIE1f21Pj1m8yb9dk5e9E+pt3Lx+Vk7DVAt4f8s0YpWCYf/fqIcLQalFuNxfX5QKz9pmN8NmOEHst69nzVY1Y+R1t6QPUdJ7CnW0SPJiY7KG3VKpDPHCwGELZDSxE8nF3ZG9MkAwJ5XfaiiZZAXi9sx2q58kal1l/UPq2PSINgKCw46+x0DaUvUrgqo76wm2+SgbR6fSg9TMYc74LgzTaamjPD+knTj7v6jpF9co1WcfFtaLSaq/9BCIb5fPm6ZlnMALI1x0ZX9g4OoSIrvK1+EvEdyi2SfDIg9XzhXy1OsRkASz+sKZjoWlfIjskv8hHwh0nfTf1e4w2rV28b+DS77GwOBpUJmi3mLq7zsbf0FDFxJs/RR/sdf7RnhsbM8qGir6LudYeHi0wu9npwWNR/Khp3r9EdKQAxTYJHp9LCgG5Pi6WGoCFJtz/RPx5Weaob2QiG3HZzhf5Kv7YHhHH+Ly7PaA6x27R0aRpSaAy5d07GeOmzJPLr/lB4mCucLiLqv0SLyJau12jOPq8MI7l11N98xBYSVS7x3w/8/mZbBfbgOevfBvLeDqGdx/y2CCs4rQv+XlWcwkE+veToCnHBnlKq3gvYhObJFHh4UTcYB7yOn0wG42edJVXwPe8CiHHupkdkvnBcx+NjuhbKBHX13wVG2O2dXQ/TavVxFZx9HTdvWsb15tRjhdGNYG2tYFdsCYu2knM9ro1Qd3xXb42iM4mscsZ5dwKrmO2Mc6axDCXgUuz3WnNaBQL7mvM9prxupe12bp2lr5/rW7flzZBH1gmAAz5OdZ3uLNNgiaEkkLyYOjlQnOXYJcHD2ubtZw73W4wVnSzk/3XP33VpSASoe2dEMwIffcGHgjSvt6WARtQneMCmLOqfEkHLNQ3XqLi/GK8BcUM00orbzNMu+grB3Nd3uV1kaW78TqjvFvcBRhneB972hit0sLfkOdDr9YuBwfTwueRtcSePCD0cgzCcNBEaJOwoNgmQeN7SSGgIpa0cgUWp0iiRtHdijF2VmDR31VMqAhab8epLISDH59Ny0LtBK3oSn4K2OHEzp89XQIBBY8Qe9qYJPm5vIPqrfFDReoze9gYacvi39BR7R3kdbHLTcXsaDbbSXWNtu+D3fxy+zspE+cR9lm37A+4r2aXecdopZd9Sa6hcWJA6aOdGnGIOyi2SdjEyqvYrHUEWcPXc/KiW1YE9+3LZAOwnsM4gfYyItuBe2odfHRxzhG82F6IAz+NT1jQovSbPSVrGMXTGxij9nQJQi/aioF1wtHj+3HU5vPid+XzlT7bSu3oSsicVRBASTqvXa/bCHQV7yQrPzJZw03antZmNhsh1KDwGVdqlvcAHemCAUHOd1+SMlf7van3wKKve/1cJTkotgnpmJWkHMQZEN0/vnp4bGKVtLrG3e4T7OIdNbKvGVfxVw9vGLfVHePCvbFLpJ0aLXZ8Q+6xt9n7lY64u30KEMQirNe6k0MMtB1DKooLfQM179sIM+yC2kPnNBU/5pqULvczeT40LFuoi+7nSqt7dT83EgTCuGFPOydOVKO2W2cUkPvwTR9dm0fxtFDBAffH5DVoCOLn7WFl5D1P2jUnvKti+zpLKwYExTYJmz1mk6xKqDV8QwOLKghKCG9ZKGBxObhMnZnAxueHwMYuNtrFus/tBd/zKvQlzMPv3W11fh/umiGBcQqBY0+XQAwcpGmr3TcrOIviMVbPmoj4s5dufjmbn3ndRqyvw85d5vMiGVada8O1mDJKpRJKaaQf2MPalD3ScF3z9Ewlt36IIZMU0u6y58VdF2RtJxzWDT2AWJT+hWtdztPm76XN285nzLNQl5IXquhLaYev7FllMBaQqK727+ZCG9DudcYS+pbt67VFOtkfFNskbAKI2Q61hm/IIBZZhOYVxCZb4d07d7iMvMBG5mfjJu5RfV7f8yponf5gD4NH+7xA5k7MVuBObg/LtHKvBkjCZA8NWOQjYzQEg33pVCDKjICM1D38LsS6S8Etf3OSMzYcVr02uMTjWuByb18ywPDUJuu6/d2ywfYIhoBNu5lGZMv/meoA9nrwmeS42e56RVRkjGzmWvG+Zy/e+n5bf8G1LjLVm0R8xfuo0we7DjXaJUgIKt8Knw9u+FWNPLjH+FmMBZwbF/5aoRmlpIUVDV+mb4nQLvd14j9ME0+CBhOefHNqYXeNcXEmXrBYgOhPZQEUbLwTxLVZmKbpd1qrb5Bh1RdhvQ4sQuC2ak+9w5dSSK7weU50UdrJJyA2N5X+QniLPavFpvGCcd+2jBoW6/mSUTkwn3yrY/UmmkcTzCk/RR+cg1eKSqIjWdx/Ie9/HiLb/rxcj34zS5KrTa8HYq9U+mucxO+vyWu4vmX/tcbEb0QA/lO+j2XOexvH8Xmt54fyWZDQa11fn8jfutp2XoQAypewymN2q2UeXtYxV9HRahtFb3Wqr8ax+kL+f2k4cF36C/0NSRLLpdQEaa/oTZ22k59/Ag8xe9qIcrvB4OBD6a88tv8V+lqGMZDIfYV3g0r1G6USc083tRuuR9r4Wp17Kp+nULbLIPdR6/RbbNBgXOEap9OD87hnNkRi+b7of7KGQf9evsa1pr9wZ5sEjUw4nu+ades+RuoBd0osglEzFQt/CC084OS/vLXimwc5di3wIJZFWuYeDus8YrB9FtpAnv5ej9He5VTQytvM5IhhtYdkAxt2VLOd6FZGK4gBW8mh3OchIu5A5MN4ANEGsYRju3t3mBeRwqSN0N4E5jKIZDlcfn68r3xdx/VBYBrjhtJPcS7/vSKUBIj21kIb4PPJnLt2PMFYa3YYIaIXQrrQRmhj+f+d5cnA513c28Ka46hW28kzxufcDy7J9bWVZ392XzEe0G5os03thvaGQaWu8QSGpZVxKO+J98PYEzGuMQ6zeyb/WxDaGH+6Z6XZ+gzFNgka33cnreWReAgWUljY2gRrKIWlsFiBALcLrJ0LcPvwHRthHeljXI8V11eMkUAe6L6L6xVSvw1iaZr2asFiYn89NfJh4Y/dGntKNlB2+c4BV+5Kbt+bgPjDnCJzTW1vDsxPmJcgUlwL7QzMb5jvrBG0Mrlru+ZyjoRRE0bOmmNqYkJ6FrHyO2Nxb6dXsDNrX6qEEYzSdnjGBPd8aYHta1moWS2y/ob2bmJQwXtDpMthrd/Fve3C0EW6hWKbhM5OrMaNaVDjk+wPPDQhwLHAygQ4vrALjqzemRC3C9WxWaTgobsQyRvJ/YyJS8RXJqjNlyzmZJH4EVzjzPtCWL98dB/XE/riR6nE2zGKewKXWXvaH7Ru5QbaFRgvQ1rMN8XsqG4QANhpbhsrjXsAV2GzE7owLG4co2bukvkKcx9E+q7yQWAOxLxr5scNQtfOqWN8hi6vDUZOeENZA8DaZ3p2LWjTLo0R2zD39uWja7iO0wwWy7azghFtt/if4YHPjue8HXMb12z5/gZjStv+hue7vK8x8MvpKWNQ+r/cS9xT3FsK7fCgfz8JHpdJWlzTxOJJ+kF+B28Xi1OfQVsgBtSeesMH0U9v+3xv6mR03gV9bO9Nzx8Xc/9pz7Yuni0mBn0R0/sW8b3zg+RtV/fMxswWYrZhaLTHazGxwHN9mF3fPvNVZNcCzxi002kCKIu9taeRi+su941t/aF8b7tuu7rXtw20d76yRddrq3Jf63Is5Fn3vpv6Vrlfdd0mpDkU24QQQgghZGc0EduEEBIidCMnhBBCCCGEEEIcQ7FNCCGEEEIIIYQ4hmKbEEIIIYQQQghxDMU2IYQQQgghhBDiGIptQgghhBBCCCHEMRTbhBBCCCGEEEKIYyi2CSGEEEIIIYQQp0TR/wcac0lGwpRqRwAAAABJRU5ErkJggg=="
                        },
                        nombre: {
                            valor: "Tesorería General de la República de Chile"
                        }
                    }
                }
            }
        },
        certificado: {
            etiqueta: "Certificado de Pago",
            prioridad: "B",
            tipo: "certificado",
            valor: {
                pagos: {
                    etiqueta: "Pago",
                    prioridad: "B",
                    tipo: "pago",
                    valor: {
                        datos: {
                            etiqueta: "",
                            prioridad: "A",
                            tipo: "datos_pago",
                            valor: datos_pago
                        },
                        concepto: {
                            etiqueta: "Concepto de Pago",
                            prioridad: "B",
                            tipo: "string",
                            valor: resumenData.conceptoVista
                        }
                    }
                },
                beneficiario: {
                    etiqueta: "Receptor",
                    prioridad: "A",
                    tipo: "persona",
                    valor: {
                        nombre: {
                            etiqueta: "Nombre",
                            prioridad: "B",
                            tipo: "string",
                            valor: beneficiario
                        },
                        rut: {
                            etiqueta: "RUT",
                            prioridad: "C",
                            tipo: "string",
                            valor: funciones.separadorMiles(rut)+"-"+dv
                        }
                    }
                }
            }
        },
        posdata: {
            etiqueta: "Información",
            prioridad: "C",
            tipo: "lista",
            valor: [{
                prioridad: "A",
                tipo: "string",
                valor: "El Servicio de Tesorería certifica que el RUT "+funciones.separadorMiles(rut)+"-"+dv+" ha recibido un pago por un total de "+funciones.separadorMiles(monto)+ " "+ resumenData.moneda + ". La Institución o persona ante quien se presenta este certificado, podrá verificar su autenticidad en www.tgr.cl, ingresando el número del código de barra que se indica en el certificado."
            }]
        }

    };
    
    return {"data":certificadoData};
}

async function dataCertificadoMandante(resumenData, detalleData) {
    
    resumenData = replace_Elements(resumenData);
    let monto = resumenData.monto;
    
    let receptor, rutReceptor,dvReceptor;
    let paternoReceptor =  detalleData.beneficiario.paterno;
    let maternoReceptor = (detalleData.beneficiario.hasOwnProperty("materno") && _.size(detalleData.beneficiario.materno) > 0) ? detalleData.beneficiario.materno + " " : "";
    let nombresReceptor = (detalleData.beneficiario.hasOwnProperty("nombres") && _.size(detalleData.beneficiario.nombres) > 0) ? detalleData.beneficiario.nombres + " " : "";
    
    receptor = nombresReceptor+maternoReceptor+paternoReceptor;
    rutReceptor = resumenData.rut;
    dvReceptor = digitoVerificador(resumenData.rut);
    
    let emisor, rutEmisor,dvEmisor;
    let paternoEmisor =  detalleData.mandatario.paterno;
    let maternoEmisor = (detalleData.mandatario.hasOwnProperty("materno") && _.size(detalleData.mandatario.materno) > 0) ? detalleData.mandatario.materno + " " : "";
    let nombresEmisor = (detalleData.mandatario.hasOwnProperty("nombres") && _.size(detalleData.mandatario.nombres) > 0) ? detalleData.mandatario.nombres + " " : "";
    
    emisor = nombresEmisor+maternoEmisor+paternoEmisor;
    rutEmisor = detalleData.rutMandante;
    dvEmisor = digitoVerificador(detalleData.rutMandante);
    
    let datos_pago = {};
    if(detalleData.data.uploadMedioPago == "DEPOSITO"){

        datos_pago = {
                                fechaPago: {
                                    etiqueta: "Fecha de Pago",
                                    prioridad: "A",
                                    tipo: "date",
                                    valor: resumenData.fechaPago
                                },
                                monto: {
                                    etiqueta: "Monto",
                                    prioridad: "B",
                                    tipo: "string",
                                    valor: funciones.separadorMiles(monto)+" "+resumenData.moneda
                                },
                                medioPago: {
                                    etiqueta: "Medio de Pago",
                                    prioridad: "F",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadMedioPago)
                                }
                            };
    
    }
    
    else if(detalleData.data.uploadMedioPago == "CHEQUE"){

        datos_pago = {
                                fechaPago: {
                                    etiqueta: "Fecha de Pago",
                                    prioridad: "A",
                                    tipo: "date",
                                    valor: resumenData.fechaPago
                                },
                                monto: {
                                    etiqueta: "Monto",
                                    prioridad: "B",
                                    tipo: "string",
                                    valor: funciones.separadorMiles(monto)+" "+resumenData.moneda
                                },
                                medioPago: {
                                    etiqueta: "Medio de Pago",
                                    prioridad: "F",
                                    tipo: "string",
                                    valor: _.trim(detalleData.data.uploadMedioPago)
                                }
                            };
                            
        if(detalleData.data.uploadEstadoOrdenPago=="DOCUMENTO_ENVIADO" && detalleData.data.uploadFechaReemplazo){
            let fechaAct= {
                                etiqueta: "Fecha de Actualización",
                                prioridad: "G",
                                tipo: "string",
                                valor: _.trim(detalleData.data.uploadFechaReemplazo)
                            };
                        
            datos_pago.fechaActualizacion = fechaAct;
        }
    
    }
    
    else if(detalleData.data.uploadMedioPago == "CAJA"){

        datos_pago = {
                                fechaPago: {
                                    etiqueta: "Fecha de Pago",
                                    prioridad: "A",
                                    tipo: "date",
                                    valor: resumenData.fechaPago
                                },
                                monto: {
                                    etiqueta: "Monto",
                                    prioridad: "B",
                                    tipo: "string",
                                    valor: funciones.separadorMiles(monto)+" "+resumenData.moneda
                                },
                                medioPago: {
                                    etiqueta: "Medio de Pago",
                                    prioridad: "F",
                                    tipo: "string",
                                    valor: detalleData.data.uploadMedioPago
                                }
                            };
                            
        if(detalleData.data.uploadEstadoOrdenPago=="DOCUMENTO_ENVIADO" && detalleData.data.uploadFechaReemplazo){
            let fechaAct= {
                                etiqueta: "Fecha de Actualización",
                                prioridad: "G",
                                tipo: "string",
                                valor: _.trim(detalleData.data.uploadFechaReemplazo)
                            };
            
            datos_pago.fechaActualizacion = fechaAct;
        }
        
    }
    
    let certificadoData = {
        certificador: {
            prioridad: "A",
            tipo: "certificador",
            valor: {
                primario: {
                    prioridad: "A",
                    tipo: "institucion",
                    valor: {
                        id: {
                            valor: "tesoreria"
                        },
                        logo: {
                            tipo: "base64",
                            valor: "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"
                        },
                        nombre: {
                            valor: "Tesorería General de la República de Chile"
                        }
                    }
                }
            }
        },
        certificado: {
            etiqueta: "Comprobante de Pago Endosado",
            prioridad: "B",
            tipo: "comprobante",
            valor: {
                pagos: {
                    etiqueta: "Pago",
                    prioridad: "B",
                    tipo: "pago",
                    valor: {
                        datos: {
                            etiqueta: "",
                            prioridad: "A",
                            tipo: "datos_pago",
                            valor: datos_pago
                        },
                        concepto: {
                            etiqueta: "Concepto de Pago",
                            prioridad: "B",
                            tipo: "string",
                            valor: resumenData.conceptoVista
                        }
                    }
                },
                emisor: {
                    etiqueta: "Emisor",
                    prioridad: "D",
                    tipo: "persona",
                    valor: {
                        nombre: {
                            etiqueta: "Nombre",
                            prioridad: "B",
                            tipo: "string",
                            valor: emisor
                        },
                        rut: {
                            etiqueta: "RUT",
                            prioridad: "C",
                            tipo: "string",
                            valor: funciones.separadorMiles(rutEmisor)+"-"+dvEmisor
                        }
                    }
                },
                receptor: {
                    etiqueta: "Receptor",
                    prioridad: "A",
                    tipo: "persona",
                    valor: {
                        nombre: {
                            etiqueta: "Nombre",
                            prioridad: "B",
                            tipo: "string",
                            valor: receptor
                        },
                        rut: {
                            etiqueta: "RUT",
                            prioridad: "C",
                            tipo: "string",
                            valor: funciones.separadorMiles(rutReceptor)+"-"+dvReceptor
                        }
                    }
                }
            }
        },
        posdata: {
            etiqueta: "Información",
            prioridad: "C",
            tipo: "lista",
            valor: [{
                prioridad: "A",
                tipo: "string",
                valor: "El servicio de Tesorería emite el comprobante que indica que el RUT "+funciones.separadorMiles(rutReceptor)+"-"+dvReceptor+"  ha recibido el pago de los documentos cedidos por el RUT "+funciones.separadorMiles(rutEmisor)+"-"+dvEmisor+" , por "+funciones.separadorMiles(monto)+ " "+ resumenData.moneda + ". La institución o persona ante quien se presenta este comprobante, podrá verificar su autenticidad en www.tgr.cl, ingresando el número del código de barra que se indica en el comprobante."
            }]
        }

    };
    
    return {"data":certificadoData};
}

const conceptoMap = new Map();
conceptoMap.set('PAGO_PROVEEDORES', 'PAGO PROVEEDORES DEL ESTADO');
conceptoMap.set('FINANCIAMIENTO_PUBLICO_ELECTORAL', 'FINANCIAMIENTO PUBLICO ELECTORAL');
conceptoMap.set('RENTA_ANTICIPADA', 'RENTA ANTICIPADA');


function replace_Elements(obj) {
    for (var prop in obj) {
        if (typeof obj[prop] === 'object') { // dive deeper in
            replace_Elements(obj[prop]);
        }
        else if (prop == "concepto") { // delete elements that are empty strings
            let concepto = conceptoMap.get(obj[prop]);

            obj[prop+"Vista"] = concepto;
        }
    }
    return obj;
}

function digitoVerificador(T){
    var M=0,S=1;
	  for(;T;T=Math.floor(T/10))
      S=(S+T%10*(9-M++%6))%11;
	  return S?S-1:'k';
}