/**
 * Winston Logger Configuration
 * Production-grade logging with file rotation and structured output
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

// Custom format for structured logging
const structuredFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

// Console format for development
const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ level, message, timestamp, ...metadata }) => {
        let msg = `${timestamp} [${level}]: ${message}`;
        if (Object.keys(metadata).length > 0) {
            msg += ` ${JSON.stringify(metadata)}`;
        }
        return msg;
    })
);

// Create Winston logger instance
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: {
        service: 'live-streaming-platform',
        environment: process.env.NODE_ENV || 'development'
    },
    transports: [
        // Write all logs to file
        new winston.transports.File({
            filename: path.join(logsDir, 'error.log'),
            level: 'error',
            format: structuredFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5
        }),
        new winston.transports.File({
            filename: path.join(logsDir, 'combined.log'),
            format: structuredFormat,
            maxsize: 5242880, // 5MB
            maxFiles: 5
        })
    ],
    // Don't exit on uncaught errors
    exitOnError: false
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: consoleFormat
    }));
}

// Stream for Morgan HTTP logging integration
logger.stream = {
    write: (message) => {
        logger.info(message.trim(), { type: 'http' });
    }
};

// Helper methods for structured logging
logger.logStreamEvent = (event, data) => {
    logger.info(`Stream Event: ${event}`, {
        type: 'stream',
        event,
        ...data
    });
};

logger.logSecurityEvent = (event, data) => {
    logger.warn(`Security Event: ${event}`, {
        type: 'security',
        event,
        ...data
    });
};

logger.logError = (error, context = {}) => {
    logger.error(error.message, {
        type: 'error',
        stack: error.stack,
        ...context
    });
};

module.exports = logger;
