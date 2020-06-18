module.exports.transactionId = 'n/a';

module.exports.log = function() {
    var args = Array.from(arguments);
    Array.prototype.unshift.call(args, '[' + this.transactionId + ']');
    console.log.apply(null, args);
};

module.exports.error = function() {
    var args = Array.from(arguments);
    Array.prototype.unshift.call(args, '[' + this.transactionId + ']');
    console.error.apply(null, args);
};