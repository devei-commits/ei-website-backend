const errorHandler = (err, req, res, next) => {
    console.log(err.status)
    if (err.status) {
        res.status(err.status).json(err.message);
    }else {
        res.status(500).json(err.message);
    }
}

module.exports = errorHandler;