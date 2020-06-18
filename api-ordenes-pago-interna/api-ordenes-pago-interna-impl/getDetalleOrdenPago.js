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


const params = {
    id: {
        transform: (field) => {
            try {
                return parseInt(field)
            }
            catch (e) {
                return -1
            }
        },
        isValid: (transformedField) => {
            return transformedField > 0
        },
        message: `El parametro 'id' debe ser un entero mayor a 0`
    },
    limit: {
        transform: (field) => {
            try {
                return parseInt(field)
            }
            catch (e) {
                return -1
            }
        },
        isValid: (transformedField) => {
            return (transformedField > 0 && transformedField <=1000)
        },
        message: `El parametro 'limit' debe ser un entero mayor a 0 y menor o igual a 1000`
    },
    next: {
        optional : true,
        transform: (field) => {
            try {
                return field
            }
            catch (e) {
                return ""
            }
        },
        isValid: (transformedField) => {
            return transformedField
        },
        message: `El parametro 'next' debe ser un string`
    }
};

function validateFormat(event) {
    let queryStringParameters = _.assign({}, event.queryStringParameters);

    let errors = [];
    let values = _.mapValues(params, (paramValue, paramName) => {
        let res;
        let field = queryStringParameters.hasOwnProperty(paramName) ?
            queryStringParameters[paramName] : paramValue.hasOwnProperty('default') ? paramValue.default : undefined;

        if (_.isUndefined(field)) {
            if (!paramValue.optional) {
                errors.push(paramValue.message);
            }
            else {
                res = undefined;
            }
        }
        else {
            let value = paramValue.transform(field);
            if (paramValue.isValid(value)) {
                res = value;
            }
            else {
                errors.push(paramValue.message);
            }
        }

        return res;
    });

    return { errors, values };
}

async function doit(values, callback) {
    let id = values.id;
    let limit = values.limit;
    let next = undefined;
    let pago;
    let totalDocumentos;
    if(values.hasOwnProperty("next")){
        next = values.next;
    }
    
    //1.- generar data "beneficiario" desde el resumen. Solo cuando es el primer llamado
    if(_.isUndefined(next)){
        var resumen = await dynamo.getItem({
            TableName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen`,
            Key: {
                idResumen: String(id)
            }
        });
        
        try{
            pago = {
                "id": resumen.idResumen,
                "rut": resumen.rut,
                "estado": resumen.estado,
                "fecha": resumen.fechaPago,
                "concepto": resumen.concepto,
                "monto": funciones.separadorMiles(resumen.monto),
                "moneda": resumen.moneda
            };
        } catch (e){
            console.log("id no encontrado");
        }
    }
    
    //2.- Tener el total de documentos independiente del limite. Solo en el primer llamado
    if(_.isUndefined(next)){
        totalDocumentos = await countTable(id);
    }
    
    //3.- ir a detalle en dynamo y obtener las trx con el idResumen
    var params = {
        TableName: `tgr-${process.env.ENV}-core-ordenes-pago-detalles`,
        IndexName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen-idx`,
        KeyConditionExpression: "idResumen = :id",
        ExpressionAttributeValues: {
            ":id": String(id)
        },
        ScanIndexForward: true,
        Limit:limit
    };
    
    if(!_.isUndefined(next)){
        params.ExclusiveStartKey = {
            idResumen: String(id),
            transactionId: next
        };
    }
    
    return new Promise((resolve, reject) => {
        docClient.query(params, async function(err, data) {
            if (err) {
                console.log("dynamodb query error:", JSON.stringify(err, null, 2), err.stack);
                reject(err);
            }
            else {
                
                if(data.Count>0){
                    if(_.isUndefined(next)){
                        //completo datos del pago
                        pago.medioPago = _.trim(data.Items[0].data.uploadMedioPago);
                        
                        if (data.Items[0].data.uploadMedioPago == 'DEPOSITO') {
                            pago.banco = _.trim(data.Items[0].data.uploadNombreBanco);
                            pago.tipoCuenta = _.trim(data.Items[0].data.uploadTipoCuenta);
                            pago.numeroCuenta = _.trim(data.Items[0].data.uploadNumeroCuenta);
                        }
                        if (data.Items[0].data.uploadMedioPago == 'CHEQUE') {
                            pago.direccionEnvio = _.trim(data.Items[0].data.uploadDireccionEnvio);
                            pago.comuna = _.trim(data.Items[0].data.uploadNombreComuna);
                        }
        
                        if (data.Items[0].data.hasOwnProperty("uploadFechaReemplazo")) { //puede ser para CHEQUE o para CAJA
                            pago.fechaActualizacion = _.trim(data.Items[0].data.uploadFechaReemplazo);
                        }
                    }
                    
                    
                    let listaDocumentos = [];
                    /*let promises = _.map(data.Items, async(detalle) => {
                        let documento = await armarDocumentos(detalle.concepto, detalle);
                        listaDocumentos.push(documento);
                        
                    });
                    */
                    
                    for (var detalle in data.Items) {
                        let documento = await armarDocumentos(data.Items[detalle].concepto, data.Items[detalle]);
                        listaDocumentos.push(documento);
                        
                    }
                    
                    try {
                        //await Promise.all(promises).then(async values => {
                            //console.log("promesas ejecutadas:");
                            let salida = {};
                            salida["pago"] = pago;
                            salida["totalDocumentos"] = totalDocumentos;
                            
                            listaDocumentos = _.orderBy(listaDocumentos, ['cabecera[0].valor'], ['asc']);
                            
                            salida["documentos"] = listaDocumentos;
                            
                            if(data.hasOwnProperty("LastEvaluatedKey")){
                                salida["next"] = data.LastEvaluatedKey.transactionId;
                            }
                            
                            const response = {
                                statusCode: 200,
                                body: JSON.stringify(salida),
                                headers: {
                                    "Access-Control-Allow-Origin": "*", // Required for CORS support to work
                                    "Access-Control-Allow-Credentials": true, // Required for cookies, authorization headers with HTTPS
                                    'Accept': 'application/json, text/plain, */*',
                                    'Content-Type': 'application/json'
                                }
                            };
                            resolve(response);
                            //return response;
                        //});
                    } catch(e){
                        console.log("error ejecutando promesas");
                    }
                }
            }
        });
    });

}


module.exports.handler = async(event, context, callback) => {
    logger.log('call', event);

    let { errors, values } = validateFormat(event);

    if (!_.isEmpty(errors)) {
        response(400, { errors: errors }, callback);
        return;
    }

    return doit(values, callback);

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
    
    callback(null, response);
}

async function armarDocumentos(concepto, itemCompleto) {
    let item = itemCompleto.data;
    let documento = {};
    let cabecera = [],
        cuerpo = [],
        data = [];

    
    //TODO cambiar cuando se actualicen a la v3
    if (concepto == "PAGO_PROVEEDORES") { //es v1
        cabecera.push(funciones.dinamico("Num. Documento", "numero", itemCompleto.numeroDocumento));
        cabecera.push(funciones.dinamico("Monto", "monto", funciones.separadorMiles(itemCompleto.monto) + " " + itemCompleto.moneda));

        let titulo = "";
        data.push(funciones.dinamico("FECHA DE EMISION", "fecha", itemCompleto.fechaEmisionDocumento));
        data.push(funciones.dinamico("TIPO DE DOCUMENTO", "texto", _.replace(itemCompleto.tipoDocumento, '_', ' ')));

        cuerpo.push({ "titulo": titulo, "data": data });

        data = [];

        titulo = "EMISOR DEL DOCUMENTO";
        data.push(funciones.dinamico("NOMBRE", "texto", funciones.nombreCompleto(itemCompleto, concepto)));
        if(itemCompleto.rutMandante){
            data.push(funciones.dinamico("RUT", "texto", funciones.separadorMiles(itemCompleto.rutMandante) + "-" + dv(itemCompleto.rutMandante)));
            cuerpo.push({ "titulo": titulo, "data": data });
        } else {console.log("no tiene rut mandante el item:", item)}
        data = [];
        
        if(itemCompleto.rutInstitucion){
            titulo = "INSTITUCION PAGADORA";
            data.push(funciones.dinamico("RUT", "texto", funciones.separadorMiles(itemCompleto.rutInstitucion) + "-" + itemCompleto.dvInstitucion));
        
            cuerpo.push({ "titulo": titulo, "data": data });
        } else {console.log("no tiene rut institucion el item:", item)}
        
        documento.cabecera = cabecera;
        documento.cuerpo = cuerpo;

    }
    else if (concepto == "FINANCIAMIENTO_PUBLICO_ELECTORAL") { //es v2

        cabecera.push(funciones.dinamico("Monto", "monto", funciones.separadorMiles(itemCompleto.monto) + " " + itemCompleto.moneda));
        cabecera.push(funciones.dinamico("NOMBRE ELECCION", "texto", itemCompleto.nombreEleccion));

        let titulo = "";
        data.push(funciones.dinamico("FECHA ELECCION", "fecha", itemCompleto.fechaEleccion));
        data.push(funciones.dinamico("AÑO TRIMESTRE", "numero", itemCompleto.agnoTrimestre));

        cuerpo.push({ "titulo": titulo, "data": data });

        data = [];

        titulo = "EMISOR DEL DOCUMENTO";
        data.push(funciones.dinamico("NOMBRE", "texto", funciones.nombreCompleto(itemCompleto, concepto)));
        data.push(funciones.dinamico("RUT", "texto", funciones.separadorMiles(itemCompleto.rutMandante) + "-" + dv(itemCompleto.rutMandante)));

        cuerpo.push({ "titulo": titulo, "data": data });

        documento.cabecera = cabecera;
        documento.cuerpo = cuerpo;

    }
    else if (concepto == "RENTA_ANTICIPADA") {

        cabecera.push(funciones.dinamico("Monto", "monto", funciones.separadorMiles(itemCompleto.monto) + " " + itemCompleto.moneda));
        cabecera.push(funciones.dinamico("Folio Solicitud Renta", "numero", itemCompleto.folioSolicitudRenta));

        let titulo = "";
        data.push(funciones.dinamico("FECHA SOLICITUD RENTA", "fecha", itemCompleto.fechaSolicitudRenta));
        data.push(funciones.dinamico("AÑO TRIBUTARIO", "numero", itemCompleto.anoTributario));

        cuerpo.push({ "titulo": titulo, "data": data });

        data = [];

        titulo = "EMISOR DEL DOCUMENTO";
        data.push(funciones.dinamico("NOMBRE", "texto", funciones.nombreCompleto(itemCompleto, concepto)));
        data.push(funciones.dinamico("RUT", "texto", funciones.separadorMiles(itemCompleto.rutMandante) + "-" + dv(itemCompleto.rutMandante)));

        cuerpo.push({ "titulo": titulo, "data": data });

        documento.cabecera = cabecera;
        documento.cuerpo = cuerpo;

    }


    return documento;
}

async function countTable(id)  {

    var paramsCount = {
        TableName: `tgr-${process.env.ENV}-core-ordenes-pago-detalles`,
        IndexName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen-idx`,
        KeyConditionExpression: "idResumen = :id",
        ExpressionAttributeValues: {
            ":id": String(id)
        },
        ProjectionExpression: 'idResumen'
    };
    
    let i =0;
    let items;
    do{
        items =  await docClient.query(paramsCount).promise();
        items.Items.forEach(
            (item) => 
            i++
            );
        paramsCount.ExclusiveStartKey  = items.LastEvaluatedKey;
    }while(typeof items.LastEvaluatedKey != "undefined");

    return i;

}

function dv(T){
    var M=0,S=1;
	  for(;T;T=Math.floor(T/10))
      S=(S+T%10*(9-M++%6))%11;
	  return S?S-1:'k';
}
