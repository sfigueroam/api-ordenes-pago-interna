'use strict';
const AWS = require("aws-sdk");
AWS.config.update({
    region: "us-east-1"
});
var docClient = new AWS.DynamoDB.DocumentClient();
const _ = require('lodash');
const logger = require('./logger');
const funciones = require('./utils/funciones');


module.exports.handler = async(event, context, callback) => {
    logger.log('call', event);
    let body, idResumen, filtros, query;
    
    try{
        body = JSON.parse(event.body);
            
        if(body.hasOwnProperty("id")){
            idResumen = body.id;
        }
        
        if(body.hasOwnProperty("filtros")){
            filtros = body.filtros;
            query = traduccionFiltros(filtros, idResumen);
        }
        
    } catch (e){
        console.log("error formato json");
    }
    let pago;
    let coincidencias=0;

    //ir a detalle en dynamo y obtener las trx con el idResumen
    var params = {
        TableName: `tgr-${process.env.ENV}-core-ordenes-pago-detalles`,
        IndexName: `tgr-${process.env.ENV}-core-ordenes-pago-resumen-idx`,
        KeyConditionExpression: "idResumen = :id",
        ExpressionAttributeValues: query.eaFinal,
        FilterExpression: query.feFinal,
        ScanIndexForward: true
    };
    
    console.log(params);
    
    let detalles, listaDocumentos = [], contador=0;
    
    
    do{
        detalles =  await docClient.query(params).promise();
        contador = contador + detalles.ScannedCount;
        
        for (var detalle in detalles.Items) {
            let documento = await armarDocumentos(detalles.Items[detalle].concepto, detalles.Items[detalle]);
            listaDocumentos.push(documento);
            
        }
        params.ExclusiveStartKey  = detalles.LastEvaluatedKey;
    }while(typeof detalles.LastEvaluatedKey != "undefined");   

    coincidencias = listaDocumentos.length;
    let salida = {};
    salida["pago"] = pago;
    salida["coincidencias"] = coincidencias;
    salida["totalDocumentos"] = contador;
    
    listaDocumentos = _.orderBy(listaDocumentos, ['cabecera[0].valor'], ['asc']);
    
    salida["documentos"] = listaDocumentos;
    
    let resp = 200;
    coincidencias==0 ? resp=404 : resp;
    
    const response = {
        statusCode: resp,
        body: JSON.stringify(salida),
        headers: {
            "Access-Control-Allow-Origin": "*", // Required for CORS support to work
            "Access-Control-Allow-Credentials": true, // Required for cookies, authorization headers with HTTPS
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json'
        }
    };
    
    return response;

};

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

function dv(T){
    var M=0,S=1;
	  for(;T;T=Math.floor(T/10))
      S=(S+T%10*(9-M++%6))%11;
	  return S?S-1:'k';
}


function traduccionFiltros(filtros, idResumen){
    let feFinal="";
    let eaFinal={};
    
    filtros = _.orderBy(filtros, ['orden'], ['asc']);

    for(let i =0; i<filtros.length;i++){
        let fe = filtros[i].prefijo+" ";
        if(filtros[i].condicion!="[b]"){
            fe = fe + filtros[i].nombre+" " + filtros[i].condicion+" :"+ filtros[i].nombre+"_"+i+" ";
        } else {
            let j = i+1;
            fe = fe + filtros[i].nombre+" " + filtros[i].condicion+" :"+ filtros[i].nombre+"_"+i+" and :"+filtros[i].nombre+"_"+j;
        }
        fe = fe + filtros[i].sufijo+" ";
        
        feFinal = feFinal + fe;
        
        //ExpressionAttributeValues
        if(filtros[i].condicion!="[b]" && filtros[i].tipo=="string"){
            eaFinal[":"+filtros[i].nombre+"_"+i] = String(filtros[i].valor);
        } else if(filtros[i].condicion!="[b]" && filtros[i].tipo=="number"){
            eaFinal[":"+filtros[i].nombre+"_"+i] = Number(filtros[i].valor);
        }
        else {
            let rango = _.split(filtros[i].valor, '@');
            let j = i+1;
            if(filtros[i].tipo=="string") {
                eaFinal[":"+filtros[i].nombre+"_"+i] = String(rango[0]);
                eaFinal[":"+filtros[i].nombre+"_"+j] = String(rango[1]);
            } else {
                eaFinal[":"+filtros[i].nombre+"_"+i] = Number(rango[0]);
                eaFinal[":"+filtros[i].nombre+"_"+j] = Number(rango[1]);
            }
        }
    }
    
    //agrego idResumen
    eaFinal[":id"] = String(idResumen);
    feFinal = reemplazos(feFinal);
    return {"feFinal":feFinal, "eaFinal":eaFinal};
}

function reemplazos(feFinal){
    
    feFinal = feFinal.replace(/\[a\]/g, 'and');
    feFinal = feFinal.replace(/\[o\]/g, 'or');
    feFinal = feFinal.replace(/\[b\]/g, 'between');
    feFinal = feFinal.replace(/\[eq\]/g, '=');
    feFinal = feFinal.replace(/\[lt\]/g, '<');
    feFinal = feFinal.replace(/\[lte\]/g, '<=');
    feFinal = feFinal.replace(/\[gt\]/g, '>');
    feFinal = feFinal.replace(/\[gte\]/g, '>=');
    feFinal = feFinal.replace(/\[ne\]/g, '!=');
    feFinal = feFinal.replace(/\[nin\]/g, 'not in');
    return feFinal;
}