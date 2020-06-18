'use strict';
const AWS = require("aws-sdk");
AWS.config.update({
    region: "us-east-1"
});
var docClient = new AWS.DynamoDB.DocumentClient();
const _ = require('lodash');
const logger = require('./logger');
const dynamo = require('./aws/dynamodbServices');

const params = {
    rut: {
        transform: (field) => {
            try {
                return parseInt(field)
            } catch (e) {
                return -1
            }
        },
        isValid: (transformedField) => {
            return transformedField > 0
        },
        message: `El parametro 'rut' debe ser un entero mayor a 0`
    },
    anio: {
        transform: (field) => {
            try {
                if(parseInt(field) && field>=2019 && field <3000){
                    return parseInt(field)
                } else return -1
            } catch (e) {
                return -1
            }
        },
        isValid: (transformedField) => {
            return transformedField > 0
        },
        message: `El parametro 'anio' no cumple con el rango de años permitido`
    },
    mes: {
        transform: (field) => {
            try {
                if(parseInt(field) && field>0 && field <13){
                    return parseInt(field)
                } else return -1
            } catch (e) {
                return -1
            }
        },
        isValid: (transformedField) => {
            return transformedField > 0
        },
        message: `El parametro 'mes' debe ser un entre numero entre 1 y 12`
    },
    estado: {
        transform: (field) => {
            try {
                return _.toString(field)
            } catch (e) {
                return -1
            }
        },
        isValid: (transformedField) => {
            return _.size(transformedField) > 0
        },
        message: `El parametro 'estado' es obligatorio`
    }
};

const conceptoMap = new Map();
conceptoMap.set('PAGO_PROVEEDORES', 'PAGO PROVEEDORES DEL ESTADO');
conceptoMap.set('FINANCIAMIENTO_PUBLICO_ELECTORAL', 'FINANCIAMIENTO PUBLICO ELECTORAL');
conceptoMap.set('RENTA_ANTICIPADA', 'RENTA ANTICIPADA');

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
            } else {
                res = undefined;
            }
        } else {
            let value = paramValue.transform(field);
            if (paramValue.isValid(value)) {
                res = value;
            } else {
                errors.push(paramValue.message);
            }
        }

        return res;
    });

    return {errors, values};
}

async function doit(values, callback) {
    let rut = values.rut;
    let mes = _.padStart(values.mes, 2, '0');
    let anio= values.anio;
    let estado = values.estado;
    
    let resumenCompleto= {};
    resumenCompleto["pagos"] = [];
    let fechaPagoIni = anio+"-"+mes+"-01T00:00:00";
    let fechaPagoFin = anio+"-"+mes+"-31T23:59:59";
    let ini1 = null;
    let ini2 = null;
    
    //0.- buscar los idResumen del mes para ese rut. Paso previo al flujo normal
    var params = {
        TableName: `tgr-${process.env.ENV}-core-ordenes-pago-detalles`,
        IndexName: `tgr-${process.env.ENV}-core-ordenes-pago-rutMandante-fechaPago-idx`,
        KeyConditionExpression: "rutMandante = :rut and fechaPago between :fechaPagoIni and :fechaPagoFin",
        ScanIndexForward: false,
        ProjectionExpression: "idResumen"
    };
    
    params.ExpressionAttributeValues = {
            ":rut": Number(rut),
            ":fechaPagoIni": fechaPagoIni,
            ":fechaPagoFin": fechaPagoFin
    };
    
    let listaDetalles = await dynamo.query(params);
    let lista = [];
    
    for(let i=0;i< listaDetalles.Items.length;i++){
        //eliminar repetidos del los resumenes
        lista[i] = listaDetalles.Items[i].idResumen;
    }
    
    let listaFiltrada = _.uniq(lista);
    
    let promises = _.map(listaFiltrada, async(unDetalle) => {
        //1.- traer resumenes y despues ir por los detalles de los que cumplen condiciones
        var params = {
            TableName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen`,
            KeyConditionExpression: "idResumen = :idResumen",
            ScanIndexForward: false, //descendente
            ProjectionExpression: "idResumen, concepto, estado, fechaPago, institucion, moneda, monto, rut, beneficiario"
        };
        
        if(estado=="CONFIRMADO"){
            ini1 = "C";
            params.ExpressionAttributeValues = {
                ":idResumen": unDetalle,
                ":rut": Number(rut),
                ":ini1": ini1
            };
            params.FilterExpression = 'begins_with(estado,:ini1) and rut <> :rut';
        }else if(estado=="PENDIENTE"){
            ini1 = "P";
            params.ExpressionAttributeValues = {
                ":idResumen": unDetalle,
                ":rut": Number(rut),
                ":ini1": ini1
            };
            params.FilterExpression = 'begins_with(estado,:ini1) and rut <> :rut';
        }else{
            ini1 = "C";
            ini2 = "P";
            params.ExpressionAttributeValues = {
                ":idResumen": unDetalle,
                ":rut": Number(rut),
                ":ini1": ini1,
                ":ini2": ini2
            };
            params.FilterExpression = '(begins_with(estado,:ini1) or begins_with(estado,:ini2)) and rut <> :rut';
        }
        
        var unResumen = await dynamo.query(params);
        if(unResumen.Items[0]!= undefined){
            resumenCompleto.pagos.push(unResumen.Items[0]);
        }
    });
    
    try {
        await Promise.all(promises).then(async values => {
            console.log("promesas ejecutadas:");
            
            resumenCompleto.pagos = replace_Elements(resumenCompleto.pagos);
    
            resumenCompleto.pagos = infoBeneficiario(resumenCompleto.pagos);
            
            resumenCompleto.pagos = _.orderBy(resumenCompleto.pagos, ['fechaPago', 'institucion','nombreBeneficiario','monto'], ['desc', 'asc','asc','asc']);
            
        });
    } catch(e){
        console.log("error ejecutando promesas");
    }
    
    resumenCompleto.cantidad = resumenCompleto.pagos.length;
    
    resumenCompleto.pagos = await calcularMontoReal(rut, resumenCompleto.pagos);
    
    resumenCompleto.totalMes = _.sumBy(resumenCompleto.pagos, 'monto');
    
    const response = {
        statusCode: 200,
        body: JSON.stringify(resumenCompleto),
        headers: {
            "Access-Control-Allow-Origin": "*", // Required for CORS support to work
            "Access-Control-Allow-Credentials": true, // Required for cookies, authorization headers with HTTPS
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json'
        }
    };
    
    return response;
}


module.exports.handler = async (event, context, callback) => {
    logger.log('call', event);

    let {errors, values} = validateFormat(event);

    if (!_.isEmpty(errors)) {
        response(400, {errors: errors}, callback);
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

    console.log('response', response);
    callback(null, response);
}

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

function infoBeneficiario(pagos){
    for (let i=0;i<pagos.length;i++) {
        let paterno = pagos[i].beneficiario["paterno"];
        let materno = (pagos[i].beneficiario.hasOwnProperty("materno") && _.size(pagos[i].beneficiario.materno) > 0) ? pagos[i].beneficiario.materno + " " : "";
        let nombres = (pagos[i].beneficiario.hasOwnProperty("nombres") && _.size(pagos[i].beneficiario.nombres) > 0) ? pagos[i].beneficiario.nombres + " " : "";
        
        pagos[i]["nombreBeneficiario"] =  nombres+materno+paterno;
    
        
        pagos[i]["rutBeneficiario"] =  pagos[i].rut;
        
        delete pagos[i].rut;
        delete pagos[i].beneficiario;
    }
    
    return pagos;
}

async function traerDetalles(rut, pagos){
    let i=0;
    let monto = 0;
    
    for(i=0;i<pagos.length;i++)
    {
        var params = {
            TableName: `tgr-${process.env.ENV}-core-ordenes-pago-detalles`,
            //IndexName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen-idx`,
            //KeyConditionExpression: "idResumen = :id",
            ExpressionAttributeValues: {
                ":id": String(pagos[i].idResumen),
                ":rutMandante":  Number(rut)
            },
            FilterExpression: 'rutMandante = :rutMandante and idResumen = :idResumen'
        };
        
        let consulta = await docClient.query(params).promise();
        let j=0;
        for(j=0; j<consulta.Items.length;j++){
            monto = monto + consulta.Items[j].monto;
        }
        
        pagos[i].monto = monto;
    }
    
    return pagos;
}

async function calcularMontoReal(rut, pagos){
    let i=0;
    let consulta;
    
    for(i=0;i<pagos.length;i++)
    {
        let monto = 0;
        var params = {
            TableName: `tgr-${process.env.ENV}-core-ordenes-pago-detalles`,
            IndexName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen-idx`,
            KeyConditionExpression: "idResumen = :id",
            ExpressionAttributeValues: {
                ":id": String(pagos[i].idResumen),
                ":rutMandante":  Number(rut)
            },
            FilterExpression: 'rutMandante = :rutMandante'
        };
        
        
        do{
            consulta = await docClient.query(params).promise();
            let j=0;
            for(j=0; j<consulta.Items.length;j++){
                monto = monto + consulta.Items[j].monto;
            }
        
            params.ExclusiveStartKey  = consulta.LastEvaluatedKey;
        }while(typeof consulta.LastEvaluatedKey != "undefined");
        
        
        pagos[i].monto = monto;
    }
    
    return pagos;
}