/**
 * HLS Stream Proxy Module
 * Securely proxies HLS streams with CORS handling, caching, and error recovery
 * 
 * Why HLS over WebRTC:
 * 1. Better scalability - HLS uses HTTP/CDN infrastructure
 * 2. Native browser support via hls.js (no plugin needed)
 * 3. Adaptive bitrate streaming (ABR) built-in
 * 4. Works through firewalls and proxies
 * 5. Lower server complexity for one-to-many broadcasts
 * 6. Better for recorded content and DVR functionality
 * 7. Chrome has excellent HLS.js support
 */

const http = require('http');
const https = require('https');
const url = require('url');
const { decryptUrl } = require('./auth');
const logger = require('./logger');

// Simple in-memory cache for segments (use Redis in production)
const segmentCache = new Map();
const CACHE_MAX_SIZE = 50 * 1024 * 1024; // 50MB max cache
let currentCacheSize = 0;

// Request timeout configuration
const REQUEST_TIMEOUT = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

/**
 * Proxy HLS manifest (.m3u8) request
 * @param {string} encryptedUrl - Encrypted source URL
 * @param {Object} res - Express response object
 * @param {string} baseProxyUrl - Base URL for proxying segments
 */
async function proxyManifest(encryptedUrl, res, baseProxyUrl) {
    try {
        const originalUrl = decryptUrl(encryptedUrl);
        logger.logStreamEvent('proxy_manifest_request', { url: maskUrl(originalUrl) });

        const parsedUrl = url.parse(originalUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.path,
            method: 'GET',
            timeout: REQUEST_TIMEOUT,
            headers: {
                'User-Agent': 'LiveStreamingPlatform/1.0',
                'Accept': '*/*',
                'Accept-Encoding': 'identity'
            }
        };

        const proxyReq = client.request(options, (proxyRes) => {
            // Set CORS headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

            // Handle redirects
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                const redirectUrl = url.resolve(originalUrl, proxyRes.headers.location);
                logger.logStreamEvent('manifest_redirect', { redirectUrl: maskUrl(redirectUrl) });
                
                // Re-encrypt the redirect URL and proxy again
                const { encryptUrl } = require('./auth');
                const encryptedRedirect = encryptUrl(redirectUrl);
                return proxyManifest(encryptedRedirect, res, baseProxyUrl);
            }

            if (proxyRes.statusCode !== 200) {
                logger.logError(new Error(`Manifest request failed: ${proxyRes.statusCode}`), {
                    url: maskUrl(originalUrl),
                    statusCode: proxyRes.statusCode
                });
                return res.status(502).json({
                    error: 'Failed to fetch manifest',
                    statusCode: proxyRes.statusCode
                });
            }

            let data = '';
            proxyRes.on('data', chunk => data += chunk);
            proxyRes.on('end', () => {
                try {
                    // Rewrite URLs in manifest to point to our proxy
                    const rewrittenManifest = rewriteManifestUrls(
                        data,
                        originalUrl,
                        baseProxyUrl,
                        encryptedUrl
                    );

                    res.status(200).send(rewrittenManifest);
                    
                    logger.logStreamEvent('manifest_proxied', {
                        url: maskUrl(originalUrl),
                        size: rewrittenManifest.length
                    });
                } catch (error) {
                    logger.logError(error, { context: 'rewriteManifestUrls' });
                    res.status(500).json({ error: 'Failed to process manifest' });
                }
            });
        });

        proxyReq.on('error', (error) => {
            logger.logError(error, { context: 'proxyManifest request', url: maskUrl(originalUrl) });
            res.status(502).json({ error: 'Failed to connect to stream source' });
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            logger.logError(new Error('Manifest request timeout'), { url: maskUrl(originalUrl) });
            res.status(504).json({ error: 'Stream source timeout' });
        });

        proxyReq.end();

    } catch (error) {
        logger.logError(error, { context: 'proxyManifest' });
        res.status(500).json({ error: 'Internal proxy error' });
    }
}

/**
 * Proxy HLS segment (.ts) request with caching
 * @param {string} encryptedUrl - Encrypted source URL
 * @param {Object} res - Express response object
 */
async function proxySegment(encryptedUrl, res) {
    try {
        // Check cache first
        const cacheKey = encryptedUrl;
        const cachedSegment = segmentCache.get(cacheKey);
        
        if (cachedSegment && Date.now() - cachedSegment.timestamp < 30000) {
            // Cache hit (30 second TTL for segments)
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('X-Cache', 'HIT');
            res.setHeader('Cache-Control', 'public, max-age=30');
            return res.status(200).send(cachedSegment.data);
        }

        const originalUrl = decryptUrl(encryptedUrl);
        
        const parsedUrl = url.parse(originalUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.path,
            method: 'GET',
            timeout: REQUEST_TIMEOUT,
            headers: {
                'User-Agent': 'LiveStreamingPlatform/1.0',
                'Accept': '*/*'
            }
        };

        const proxyReq = client.request(options, (proxyRes) => {
            // Set CORS and content headers
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Type', 'video/mp2t');
            res.setHeader('X-Cache', 'MISS');
            res.setHeader('Cache-Control', 'public, max-age=30');

            if (proxyRes.statusCode !== 200) {
                logger.logError(new Error(`Segment request failed: ${proxyRes.statusCode}`), {
                    url: maskUrl(originalUrl)
                });
                return res.status(502).end();
            }

            const chunks = [];
            
            proxyRes.on('data', chunk => {
                chunks.push(chunk);
                res.write(chunk);
            });
            
            proxyRes.on('end', () => {
                res.end();
                
                // Cache the segment
                const segmentData = Buffer.concat(chunks);
                cacheSegment(cacheKey, segmentData);
                
                logger.logStreamEvent('segment_proxied', {
                    url: maskUrl(originalUrl),
                    size: segmentData.length
                });
            });
        });

        proxyReq.on('error', (error) => {
            logger.logError(error, { context: 'proxySegment request', url: maskUrl(originalUrl) });
            if (!res.headersSent) {
                res.status(502).end();
            }
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            logger.logError(new Error('Segment request timeout'), { url: maskUrl(originalUrl) });
            if (!res.headersSent) {
                res.status(504).end();
            }
        });

        proxyReq.end();

    } catch (error) {
        logger.logError(error, { context: 'proxySegment' });
        if (!res.headersSent) {
            res.status(500).end();
        }
    }
}

/**
 * Rewrite URLs in HLS manifest to point to our proxy
 * @param {string} manifest - Original manifest content
 * @param {string} baseUrl - Base URL of original stream
 * @param {string} proxyBaseUrl - Our proxy base URL
 * @param {string} encryptedBaseUrl - Encrypted base URL for segments
 * @returns {string} Rewritten manifest
 */
function rewriteManifestUrls(manifest, baseUrl, proxyBaseUrl, encryptedBaseUrl) {
    const lines = manifest.split('\n');
    const rewritten = [];
    const { encryptUrl } = require('./auth');

    for (const line of lines) {
        const trimmedLine = line.trim();
        
        // Skip empty lines and comments (except EXT-X-KEY)
        if (!trimmedLine || (trimmedLine.startsWith('#') && !trimmedLine.startsWith('#EXT-X-KEY'))) {
            rewritten.push(line);
            continue;
        }

        // Handle key URI in EXT-X-KEY
        if (trimmedLine.startsWith('#EXT-X-KEY')) {
            const uriMatch = trimmedLine.match(/URI="([^"]+)"/);
            if (uriMatch) {
                const keyUrl = url.resolve(baseUrl, uriMatch[1]);
                const encryptedKeyUrl = encryptUrl(keyUrl);
                const proxyKeyUrl = `${proxyBaseUrl}/key?url=${encodeURIComponent(encryptedKeyUrl)}`;
                rewritten.push(line.replace(uriMatch[1], proxyKeyUrl));
                continue;
            }
        }

        // Handle variant streams (other .m3u8 URLs)
        if (trimmedLine.endsWith('.m3u8')) {
            const variantUrl = url.resolve(baseUrl, trimmedLine);
            const encryptedVariantUrl = encryptUrl(variantUrl);
            const proxyVariantUrl = `${proxyBaseUrl}/manifest?url=${encodeURIComponent(encryptedVariantUrl)}`;
            rewritten.push(proxyVariantUrl);
            continue;
        }

        // Handle media segments (.ts files)
        if (trimmedLine.endsWith('.ts') || trimmedLine.includes('.ts?')) {
            const segmentUrl = url.resolve(baseUrl, trimmedLine);
            const encryptedSegmentUrl = encryptUrl(segmentUrl);
            const proxySegmentUrl = `${proxyBaseUrl}/segment?url=${encodeURIComponent(encryptedSegmentUrl)}`;
            rewritten.push(proxySegmentUrl);
            continue;
        }

        // Handle initialization segments (.mp4, .m4s for fMP4)
        if (trimmedLine.endsWith('.mp4') || trimmedLine.endsWith('.m4s')) {
            const initUrl = url.resolve(baseUrl, trimmedLine);
            const encryptedInitUrl = encryptUrl(initUrl);
            const proxyInitUrl = `${proxyBaseUrl}/segment?url=${encodeURIComponent(encryptedInitUrl)}`;
            rewritten.push(proxyInitUrl);
            continue;
        }

        // Pass through other lines
        rewritten.push(line);
    }

    return rewritten.join('\n');
}

/**
 * Cache segment with LRU eviction
 * @param {string} key - Cache key
 * @param {Buffer} data - Segment data
 */
function cacheSegment(key, data) {
    // Check if adding this would exceed max size
    while (currentCacheSize + data.length > CACHE_MAX_SIZE && segmentCache.size > 0) {
        // Evict oldest entry
        const oldestKey = segmentCache.keys().next().value;
        const oldestEntry = segmentCache.get(oldestKey);
        currentCacheSize -= oldestEntry.data.length;
        segmentCache.delete(oldestKey);
    }

    segmentCache.set(key, {
        data,
        timestamp: Date.now()
    });
    currentCacheSize += data.length;
}

/**
 * Proxy encryption key request
 * @param {string} encryptedUrl - Encrypted key URL
 * @param {Object} res - Express response object
 */
async function proxyKey(encryptedUrl, res) {
    try {
        const originalUrl = decryptUrl(encryptedUrl);
        
        const parsedUrl = url.parse(originalUrl);
        const client = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.path,
            method: 'GET',
            timeout: REQUEST_TIMEOUT,
            headers: {
                'User-Agent': 'LiveStreamingPlatform/1.0'
            }
        };

        const proxyReq = client.request(options, (proxyRes) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');

            if (proxyRes.statusCode !== 200) {
                return res.status(502).end();
            }

            proxyRes.pipe(res);
        });

        proxyReq.on('error', (error) => {
            logger.logError(error, { context: 'proxyKey' });
            res.status(502).end();
        });

        proxyReq.end();

    } catch (error) {
        logger.logError(error, { context: 'proxyKey' });
        res.status(500).end();
    }
}

/**
 * Mask URL for logging (hide sensitive parts)
 * @param {string} urlString - URL to mask
 * @returns {string} Masked URL
 */
function maskUrl(urlString) {
    try {
        const parsed = url.parse(urlString);
        // Mask query parameters that might contain tokens
        if (parsed.query) {
            const params = new URLSearchParams(parsed.query);
            ['token', 'key', 'signature', 'policy'].forEach(param => {
                if (params.has(param)) {
                    params.set(param, '***');
                }
            });
            parsed.search = `?${params.toString()}`;
        }
        return url.format(parsed);
    } catch {
        return 'invalid-url';
    }
}

/**
 * Get proxy health status
 * @returns {Object} Health metrics
 */
function getHealthStatus() {
    return {
        cacheSize: currentCacheSize,
        cacheEntries: segmentCache.size,
        cacheMaxSize: CACHE_MAX_SIZE
    };
}

module.exports = {
    proxyManifest,
    proxySegment,
    proxyKey,
    getHealthStatus,
    maskUrl
};
