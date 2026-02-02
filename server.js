/**
 * Live Streaming Platform - Main Server
 * Production-ready HLS streaming server with secure proxy and token authentication
 * 
 * Architecture:
 * - Express.js backend with security middleware
 * - JWT-based token authentication
 * - HLS proxy with CORS support
 * - Viewer tracking and stream management
 * - Comprehensive logging and error handling
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');

// Import custom modules
const logger = require('./logger');
const {
    generateToken,
    validateToken,
    decryptUrl,
    registerViewer,
    removeViewer,
    stopStream,
    getStreamStats,
    activeStreams
} = require('./auth');
const { proxyManifest, proxySegment, proxyKey, getHealthStatus } = require('./streamProxy');
const { checkFFmpegInstallation, checkStreamHealth } = require('./ffmpeg');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Security middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "https:", "cdn.jsdelivr.net"],
            styleSrc: ["'self'", "'unsafe-inline'", "https:", "cdn.jsdelivr.net"],
            mediaSrc: ["'self'", "blob:", "data:", "*"],
            connectSrc: ["'self'", "*"],
            imgSrc: ["'self'", "data:", "blob:", "*"],
            fontSrc: ["'self'", "data:", "https:"]
        }
    },
    crossOriginEmbedderPolicy: false // Allow embedding
}));

// CORS configuration
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true
}));

// Body parsing middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.path}`, {
        ip: req.ip,
        userAgent: req.get('user-agent')?.substring(0, 100)
    });
    next();
});

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000, // 15 minutes
    max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    message: {
        error: 'Too many requests, please try again later',
        retryAfter: '15 minutes'
    },
    standardHeaders: true,
    legacyHeaders: false
});

const generateLimiter = rateLimit({
    windowMs: 5 * 60 * 1000, // 5 minutes
    max: 20, // 20 link generations per 5 minutes
    message: {
        error: 'Too many link generations, please try again later'
    }
});

// Apply rate limiting to API routes
app.use('/api/', apiLimiter);
app.use('/api/generate', generateLimiter);

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// ============================================
// API ROUTES
// ============================================

/**
 * @route   POST /api/generate
 * @desc    Generate a temporary live stream link
 * @body    { url: string, expiryMinutes?: number }
 * @returns { token, streamId, expiresAt, viewerUrl }
 */
app.post('/api/generate', async (req, res) => {
    try {
        const { url, expiryMinutes } = req.body;

        // Validate input
        if (!url) {
            return res.status(400).json({
                error: 'Missing required field: url',
                message: 'Please provide an HLS (.m3u8) URL'
            });
        }

        // Validate URL format
        if (!url.endsWith('.m3u8') && !url.includes('.m3u8?')) {
            return res.status(400).json({
                error: 'Invalid URL format',
                message: 'URL must be a valid HLS manifest (.m3u8)'
            });
        }

        // Validate URL is accessible (optional, can be disabled for faster response)
        // const healthCheck = await checkStreamHealth(url);
        // if (!healthCheck.healthy) {
        //     return res.status(400).json({
        //         error: 'Stream validation failed',
        //         message: healthCheck.error
        //     });
        // }

        // Generate token
        const result = generateToken({
            originalUrl: url,
            expiryMinutes: expiryMinutes ? parseInt(expiryMinutes) : undefined
        });

        logger.logStreamEvent('link_generated', {
            streamId: result.streamId,
            expiryMinutes: expiryMinutes || 120,
            ip: req.ip
        });

        res.status(200).json({
            success: true,
            data: {
                token: result.token,
                streamId: result.streamId,
                expiresAt: result.expiresAt,
                viewerUrl: `${req.protocol}://${req.get('host')}${result.viewerUrl}`,
                expiresIn: expiryMinutes ? `${expiryMinutes} minutes` : '2 hours'
            }
        });

    } catch (error) {
        logger.logError(error, { context: 'POST /api/generate', ip: req.ip });
        res.status(500).json({
            error: 'Failed to generate stream link',
            message: NODE_ENV === 'development' ? error.message : 'Internal server error'
        });
    }
});

/**
 * @route   GET /api/validate
 * @desc    Validate a stream token
 * @query   { token: string }
 * @returns { valid, streamData }
 */
app.get('/api/validate', (req, res) => {
    try {
        const { token } = req.query;

        if (!token) {
            return res.status(400).json({
                error: 'Missing token parameter'
            });
        }

        const validation = validateToken(token);

        if (!validation.valid) {
            return res.status(401).json({
                valid: false,
                error: validation.error
            });
        }

        res.status(200).json({
            valid: true,
            streamData: {
                streamId: validation.decoded.streamId,
                expiresAt: validation.streamData.expiresAt,
                isActive: validation.streamData.isActive,
                viewerCount: validation.streamData.viewerCount
            }
        });

    } catch (error) {
        logger.logError(error, { context: 'GET /api/validate' });
        res.status(500).json({
            error: 'Validation failed'
        });
    }
});

/**
 * @route   GET /api/stats/:streamId
 * @desc    Get stream statistics
 * @param   { streamId: string }
 * @returns { stream statistics }
 */
app.get('/api/stats/:streamId', (req, res) => {
    try {
        const { streamId } = req.params;
        const stats = getStreamStats(streamId);

        if (!stats) {
            return res.status(404).json({
                error: 'Stream not found'
            });
        }

        res.status(200).json({
            success: true,
            data: stats
        });

    } catch (error) {
        logger.logError(error, { context: 'GET /api/stats' });
        res.status(500).json({
            error: 'Failed to get stream statistics'
        });
    }
});

/**
 * @route   POST /api/stop
 * @desc    Stop a stream (invalidate all tokens)
 * @body    { streamId: string }
 * @returns { success, message }
 */
app.post('/api/stop', (req, res) => {
    try {
        const { streamId } = req.body;

        if (!streamId) {
            return res.status(400).json({
                error: 'Missing streamId'
            });
        }

        const result = stopStream(streamId);

        if (result.success) {
            logger.logStreamEvent('stream_stopped_api', { streamId });
            res.status(200).json(result);
        } else {
            res.status(404).json(result);
        }

    } catch (error) {
        logger.logError(error, { context: 'POST /api/stop' });
        res.status(500).json({
            error: 'Failed to stop stream'
        });
    }
});

// ============================================
// HLS PROXY ROUTES
// ============================================

/**
 * @route   GET /proxy/manifest
 * @desc    Proxy HLS manifest (.m3u8)
 * @query   { url: encryptedUrl }
 */
app.get('/proxy/manifest', (req, res) => {
    const { url: encryptedUrl } = req.query;

    if (!encryptedUrl) {
        return res.status(400).json({ error: 'Missing URL parameter' });
    }

    const baseProxyUrl = `${req.protocol}://${req.get('host')}/proxy`;
    proxyManifest(encryptedUrl, res, baseProxyUrl);
});

/**
 * @route   GET /proxy/segment
 * @desc    Proxy HLS segment (.ts)
 * @query   { url: encryptedUrl }
 */
app.get('/proxy/segment', (req, res) => {
    const { url: encryptedUrl } = req.query;

    if (!encryptedUrl) {
        return res.status(400).json({ error: 'Missing URL parameter' });
    }

    proxySegment(encryptedUrl, res);
});

/**
 * @route   GET /proxy/key
 * @desc    Proxy encryption key
 * @query   { url: encryptedUrl }
 */
app.get('/proxy/key', (req, res) => {
    const { url: encryptedUrl } = req.query;

    if (!encryptedUrl) {
        return res.status(400).json({ error: 'Missing URL parameter' });
    }

    proxyKey(encryptedUrl, res);
});

// ============================================
// WEBSOCKET-LIKE VIEWER TRACKING (HTTP-based)
// ============================================

/**
 * @route   POST /api/viewer/join
 * @desc    Register a viewer joining the stream
 * @body    { streamId: string, sessionId?: string }
 */
app.post('/api/viewer/join', (req, res) => {
    try {
        const { streamId, sessionId } = req.body;

        if (!streamId) {
            return res.status(400).json({ error: 'Missing streamId' });
        }

        const session = registerViewer(streamId, sessionId);
        
        res.status(200).json({
            success: true,
            sessionId: session.sessionId
        });

    } catch (error) {
        logger.logError(error, { context: 'POST /api/viewer/join' });
        res.status(400).json({
            error: error.message
        });
    }
});

/**
 * @route   POST /api/viewer/leave
 * @desc    Register a viewer leaving the stream
 * @body    { sessionId: string }
 */
app.post('/api/viewer/leave', (req, res) => {
    try {
        const { sessionId } = req.body;

        if (!sessionId) {
            return res.status(400).json({ error: 'Missing sessionId' });
        }

        removeViewer(sessionId);
        
        res.status(200).json({
            success: true
        });

    } catch (error) {
        logger.logError(error, { context: 'POST /api/viewer/leave' });
        res.status(500).json({
            error: 'Failed to remove viewer'
        });
    }
});

// ============================================
// HEALTH & STATUS ROUTES
// ============================================

/**
 * @route   GET /health
 * @desc    Health check endpoint
 */
app.get('/health', async (req, res) => {
    const ffmpegStatus = await checkFFmpegInstallation();
    const proxyHealth = getHealthStatus();
    
    res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        environment: NODE_ENV,
        version: require('./package.json').version,
        ffmpeg: ffmpegStatus,
        proxy: proxyHealth,
        activeStreams: activeStreams.size
    });
});

/**
 * @route   GET /api/streams
 * @desc    List all active streams (admin endpoint)
 */
app.get('/api/streams', (req, res) => {
    const streams = [];
    for (const [streamId, data] of activeStreams.entries()) {
        streams.push({
            streamId,
            viewerCount: data.viewerCount,
            maxViewers: data.maxViewers,
            isActive: data.isActive,
            createdAt: data.createdAt,
            expiresAt: data.expiresAt
        });
    }

    res.status(200).json({
        success: true,
        count: streams.length,
        data: streams
    });
});

// ============================================
// ERROR HANDLING
// ============================================

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Global error handler
app.use((err, req, res, next) => {
    logger.logError(err, {
        context: 'Global error handler',
        path: req.path,
        method: req.method
    });

    res.status(err.status || 500).json({
        error: 'Internal server error',
        message: NODE_ENV === 'development' ? err.message : 'Something went wrong'
    });
});

// ============================================
// SERVER STARTUP
// ============================================

const server = app.listen(PORT, () => {
    logger.info(`=================================`);
    logger.info(`Live Streaming Platform Started`);
    logger.info(`=================================`);
    logger.info(`Environment: ${NODE_ENV}`);
    logger.info(`Port: ${PORT}`);
    logger.info(`Health Check: http://localhost:${PORT}/health`);
    logger.info(`=================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, shutting down gracefully');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    logger.info('SIGINT received, shutting down gracefully');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.logError(error, { context: 'Uncaught Exception' });
    // Give time for logs to flush before exiting
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection', { reason, promise });
});

module.exports = app;
