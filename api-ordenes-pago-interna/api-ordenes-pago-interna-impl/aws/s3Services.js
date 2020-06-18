const AWS = require('aws-sdk');
AWS.config.update({region: "us-east-1"});
const logger = require('../logger');
const moment = require("moment");
s3 = new AWS.S3({apiVersion: '2006-03-01'});

exports.getObject = function (bucket, completeKey) {
    completeKey = completeKey.replace(/%3D/g,'=');

    let params = {
        Bucket: bucket,
        Key: completeKey,
    };

    return new Promise((resolve, reject) => {
        s3.getObject(params, function (err, data) {
            if (err) {
                console.log("[s3] error getObject", params, err, err.stack);
                reject(err);
            } else {
                resolve(JSON.parse(data.Body.toString('utf-8')));
            }
        });
    })
};