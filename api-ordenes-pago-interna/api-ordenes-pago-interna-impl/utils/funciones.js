'use strict';

const AWS = require("aws-sdk");
const _ = require('lodash');

AWS.config.update({
    region: "us-east-1"
});
var docClient = new AWS.DynamoDB.DocumentClient();

module.exports = {

    dinamico: function(etiqueta, tipo, valor) {
        return {
            "etiqueta": etiqueta,
            "tipo": tipo,
            "valor": valor
        };
    },

    separadorMiles: function(num) {
        if (num > 100) {
            return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        }
        else return num;

    },

    nombreCompleto: function(op) {

        let paterno = op.mandatario.paterno;
        let materno = (op.mandatario.hasOwnProperty("materno") && _.size(op.mandatario.materno) > 0) ? op.mandatario.materno + " " : "";
        let nombres = (op.mandatario.hasOwnProperty("nombres") && _.size(op.mandatario.nombres) > 0) ? op.mandatario.nombres + " " : "";

        return nombres + materno + paterno;
    }
};
