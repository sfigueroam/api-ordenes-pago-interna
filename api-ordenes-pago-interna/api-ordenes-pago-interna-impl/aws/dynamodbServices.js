'use strict';

const AWS = require("aws-sdk");
const _ = require('lodash');

AWS.config.update({
    region: "us-east-1"
});
var docClient = new AWS.DynamoDB.DocumentClient();

module.exports = {

    getItem: function(params) {

        return new Promise((resolve, reject) => {
            docClient.get(params, function(err, data) {
                if (err) {
                    console.log("dynamodb get error:", JSON.stringify(err, null, 2), err.stack);
                    reject(err);
                }
                else {
                    console.log('data', data);
                    resolve(data.Item);
                }
            });
        });
    },
    
    query: function(params) {
        return new Promise((resolve, reject) => {
            docClient.query(params, async function (err, data) {
                if (err) {
                    console.log("dynamodb query error:", JSON.stringify(err, null, 2), err.stack);
                    reject(err);
                } else {
                    resolve(data)
                }
            });
        });
    }
};
