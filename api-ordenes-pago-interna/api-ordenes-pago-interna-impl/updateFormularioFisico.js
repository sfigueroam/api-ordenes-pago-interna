'use strict';
const AWS = require('aws-sdk');
AWS.config.update({ region: 'us-east-1' });
const stepfunctions = new AWS.StepFunctions();

const logger = require('./logger');

module.exports.handler = (event, context, callback) => {
    return new Promise((resolve, reject) => {
        
        logger.log('body event', event.body);
        
        let params = {
                stateMachineArn: `arn:aws:states:us-east-1:${process.env.cuenta}:stateMachine:${process.env.prefix}-updateFF-step-func`,
                input: event.body
            };
        
        callStep(params).then(data => {
            logger.log('callStep execution OK', data);
            resolve(send(200, { message: 'Recepción correcta.' }, callback));
        }).catch(err => {
            reject(send(400, { message: err }, callback));
        });
        
        
    });
};

function send(httpCode, resultado, callback) {
    const response = {
        statusCode: httpCode,
        headers: {
            //"Access-Control-Allow-Origin": "*", // Required for CORS support to work
            "Access-Control-Allow-Credentials": true, // Required for cookies, authorization headers with HTTPS
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json'
        }
    };

    if (resultado) {
        response.body = JSON.stringify(resultado);
    }

    callback(null, response);
}

function callStep(params) {
    return new Promise((resolve, reject) => {
        stepfunctions.startExecution(params, function(err, data) {
            if (err) {
                console.log(err, err.stack);
                reject(err);
            }
            else {
                resolve(data);
            }
        });
    });
}
