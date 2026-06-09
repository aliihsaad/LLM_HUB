export function errorHandler(err, _req, res, next) {
    console.error('[Error]', err.message);
    if (res.headersSent)
        return next(err);
    const status = err.status ?? 500;
    res.status(status).json({
        error: {
            message: err.message,
            type: err.name ?? 'server_error',
        },
    });
}
//# sourceMappingURL=errorHandler.js.map