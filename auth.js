/**
 * Authentication & Token Management Module
 * Handles JWT generation, validation, and stream access control
 * 
 * Security Features:
 * - JWT-based authentication with configurable expiry
 * - Encrypted stream IDs in URLs
 * - Token refresh capability
 * - Viewer session tracking
 */

const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// Load token configuration
let tokenConfig;
try {
    tokenConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'token.json'), 'utf8'));
} catch (error) {
    logger.logError(error, { context: 'Loading token.json' });
    // Fallback configuration
    tokenConfig = {
        jwt: {
            secret: process.env.JWT_SECRET || 'fallback-secret-min-32-characters-long',
            expiresIn: '2h',
            issuer: 'live-streaming-platform',
            audience: 'stream-viewers'
        },
        stream: {
            defaultExpiryMinutes: 120,
            maxConcurrentViewers: 1000,
            tokenRefreshWindowMinutes: 15
        }
    };
}

// In-memory store for active streams (use Redis in production for distributed systems)
const activeStreams = new Map();
const viewerSessions = new Map();

/**
 * Generate a cryptographically secure stream ID
 * @returns {string} Encrypted stream ID
 */
function generateStreamId() {
    const rawId = uuidv4();
    const encrypted = crypto.createHash('sha256')
        .update(rawId + tokenConfig.jwt.secret)
        .digest('hex')
        .substring(0, 32);
    return encrypted;
}

/**
 * Generate JWT token for stream access
 * @param {Object} payload - Token payload
 * @param {string} payload.streamId - Unique stream identifier
 * @param {string} payload.originalUrl - Original HLS URL (encrypted)
 * @param {number} payload.expiryMinutes - Token expiry in minutes
 * @returns {Object} Token and metadata
 */
function generateToken(payload) {
    try {
        const streamId = payload.streamId || generateStreamId();
        const expiryMinutes = payload.expiryMinutes || tokenConfig.stream.defaultExpiryMinutes;
        
        // Encrypt the original URL before storing in token
        const encryptedUrl = encryptUrl(payload.originalUrl);
        
        const tokenPayload = {
            streamId,
            url: encryptedUrl,
            iat: Math.floor(Date.now() / 1000),
            type: 'stream-access'
        };

        const token = jwt.sign(tokenPayload, tokenConfig.jwt.secret, {
            expiresIn: `${expiryMinutes}m`,
            issuer: tokenConfig.jwt.issuer,
            audience: tokenConfig.jwt.audience,
            jwtid: uuidv4() // Unique token ID for revocation support
        });

        // Store stream metadata
        const streamData = {
            streamId,
            originalUrl: payload.originalUrl,
            encryptedUrl,
            createdAt: new Date(),
            expiresAt: new Date(Date.now() + expiryMinutes * 60 * 1000),
            viewerCount: 0,
            maxViewers: tokenConfig.stream.maxConcurrentViewers,
            isActive: true,
            tokenJti: jwt.decode(token).jti
        };

        activeStreams.set(streamId, streamData);

        logger.logStreamEvent('token_generated', {
            streamId,
            expiryMinutes,
            jti: streamData.tokenJti
        });

        return {
            token,
            streamId,
            expiresAt: streamData.expiresAt,
            viewerUrl: `/player.html?token=${token}&sid=${streamId}`
        };
    } catch (error) {
        logger.logError(error, { context: 'generateToken' });
        throw new Error('Failed to generate access token');
    }
}

/**
 * Validate and decode JWT token
 * @param {string} token - JWT token string
 * @returns {Object} Decoded token payload
 */
function validateToken(token) {
    try {
        const decoded = jwt.verify(token, tokenConfig.jwt.secret, {
            issuer: tokenConfig.jwt.issuer,
            audience: tokenConfig.jwt.audience
        });

        // Check if stream is still active
        const streamData = activeStreams.get(decoded.streamId);
        if (!streamData) {
            throw new Error('Stream not found or expired');
        }

        if (!streamData.isActive) {
            throw new Error('Stream has been stopped');
        }

        // Check token JTI matches (prevents revoked tokens)
        if (decoded.jti !== streamData.tokenJti) {
            throw new Error('Token has been revoked');
        }

        logger.logStreamEvent('token_validated', {
            streamId: decoded.streamId,
            jti: decoded.jti
        });

        return {
            valid: true,
            decoded,
            streamData
        };
    } catch (error) {
        logger.logSecurityEvent('token_validation_failed', {
            error: error.message,
            tokenPreview: token ? `${token.substring(0, 20)}...` : 'none'
        });
        return {
            valid: false,
            error: error.message
        };
    }
}

/**
 * Encrypt URL for secure storage in token
 * @param {string} url - URL to encrypt
 * @returns {string} Encrypted URL
 */
function encryptUrl(url) {
    try {
        const algorithm = 'aes-256-gcm';
        const key = crypto.scryptSync(tokenConfig.jwt.secret, 'salt', 32);
        const iv = crypto.randomBytes(16);
        
        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encrypted = cipher.update(url, 'utf8', 'hex');
        encrypted += cipher.final('hex');
        
        const authTag = cipher.getAuthTag();
        
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
    } catch (error) {
        logger.logError(error, { context: 'encryptUrl' });
        throw new Error('Failed to encrypt URL');
    }
}

/**
 * Decrypt URL from token
 * @param {string} encryptedUrl - Encrypted URL string
 * @returns {string} Decrypted URL
 */
function decryptUrl(encryptedUrl) {
    try {
        const algorithm = 'aes-256-gcm';
        const key = crypto.scryptSync(tokenConfig.jwt.secret, 'salt', 32);
        
        const [ivHex, authTagHex, encrypted] = encryptedUrl.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        decipher.setAuthTag(authTag);
        
        let decrypted = decipher.update(encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        
        return decrypted;
    } catch (error) {
        logger.logError(error, { context: 'decryptUrl' });
        throw new Error('Failed to decrypt URL - possible tampering');
    }
}

/**
 * Register a new viewer session
 * @param {string} streamId - Stream identifier
 * @param {string} sessionId - Viewer session identifier
 * @returns {Object} Session info
 */
function registerViewer(streamId, sessionId = uuidv4()) {
    const streamData = activeStreams.get(streamId);
    if (!streamData) {
        throw new Error('Stream not found');
    }

    if (streamData.viewerCount >= streamData.maxViewers) {
        throw new Error('Maximum viewer limit reached');
    }

    streamData.viewerCount++;
    
    const session = {
        sessionId,
        streamId,
        joinedAt: new Date(),
        lastActivity: new Date()
    };

    viewerSessions.set(sessionId, session);
    activeStreams.set(streamId, streamData);

    logger.logStreamEvent('viewer_joined', {
        streamId,
        sessionId,
        viewerCount: streamData.viewerCount
    });

    return session;
}

/**
 * Remove a viewer session
 * @param {string} sessionId - Viewer session identifier
 */
function removeViewer(sessionId) {
    const session = viewerSessions.get(sessionId);
    if (session) {
        const streamData = activeStreams.get(session.streamId);
        if (streamData) {
            streamData.viewerCount = Math.max(0, streamData.viewerCount - 1);
            activeStreams.set(session.streamId, streamData);

            logger.logStreamEvent('viewer_left', {
                streamId: session.streamId,
                sessionId,
                viewerCount: streamData.viewerCount
            });
        }
        viewerSessions.delete(sessionId);
    }
}

/**
 * Stop a stream and invalidate all tokens
 * @param {string} streamId - Stream identifier
 */
function stopStream(streamId) {
    const streamData = activeStreams.get(streamId);
    if (streamData) {
        streamData.isActive = false;
        streamData.stoppedAt = new Date();
        activeStreams.set(streamId, streamData);

        // Generate new JTI to invalidate existing tokens
        streamData.tokenJti = uuidv4();

        logger.logStreamEvent('stream_stopped', {
            streamId,
            finalViewerCount: streamData.viewerCount
        });

        return { success: true, message: 'Stream stopped successfully' };
    }
    return { success: false, message: 'Stream not found' };
}

/**
 * Get stream statistics
 * @param {string} streamId - Stream identifier
 * @returns {Object} Stream statistics
 */
function getStreamStats(streamId) {
    const streamData = activeStreams.get(streamId);
    if (!streamData) {
        return null;
    }

    return {
        streamId,
        isActive: streamData.isActive,
        viewerCount: streamData.viewerCount,
        maxViewers: streamData.maxViewers,
        createdAt: streamData.createdAt,
        expiresAt: streamData.expiresAt,
        uptime: Date.now() - streamData.createdAt.getTime()
    };
}

/**
 * Cleanup expired streams (call periodically)
 */
function cleanupExpiredStreams() {
    const now = new Date();
    let cleanedCount = 0;

    for (const [streamId, streamData] of activeStreams.entries()) {
        if (streamData.expiresAt < now || !streamData.isActive) {
            // Clean up viewer sessions for this stream
            for (const [sessionId, session] of viewerSessions.entries()) {
                if (session.streamId === streamId) {
                    viewerSessions.delete(sessionId);
                }
            }
            activeStreams.delete(streamId);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        logger.logStreamEvent('cleanup_expired_streams', {
            cleanedCount,
            remainingStreams: activeStreams.size
        });
    }

    return cleanedCount;
}

// Schedule periodic cleanup (every 5 minutes)
setInterval(cleanupExpiredStreams, 5 * 60 * 1000);

module.exports = {
    generateToken,
    validateToken,
    encryptUrl,
    decryptUrl,
    registerViewer,
    removeViewer,
    stopStream,
    getStreamStats,
    cleanupExpiredStreams,
    generateStreamId,
    activeStreams,
    viewerSessions,
    tokenConfig
};
