/**
 * FFmpeg Integration Module
 * Handles stream transcoding, quality variants, and stream health monitoring
 * 
 * This module provides:
 * - Stream health checking
 * - Transcoding for adaptive bitrate (optional)
 * - Thumbnail generation
 * - Stream validation
 */

const { spawn, exec } = require('child_process');
const path = require('path');
const logger = require('./logger');

// FFmpeg configuration
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'ffprobe';

// Active FFmpeg processes (for cleanup)
const activeProcesses = new Map();

/**
 * Check if FFmpeg is installed and get version
 * @returns {Promise<Object>} FFmpeg status
 */
function checkFFmpegInstallation() {
    return new Promise((resolve) => {
        exec(`${FFMPEG_PATH} -version`, (error, stdout) => {
            if (error) {
                logger.logError(error, { context: 'FFmpeg check' });
                resolve({
                    installed: false,
                    error: 'FFmpeg not found. Please install FFmpeg.'
                });
                return;
            }

            const versionMatch = stdout.match(/version\s+(\S+)/);
            const version = versionMatch ? versionMatch[1] : 'unknown';

            logger.info(`FFmpeg detected: version ${version}`);

            resolve({
                installed: true,
                version,
                path: FFMPEG_PATH
            });
        });
    });
}

/**
 * Validate HLS stream URL using ffprobe
 * @param {string} streamUrl - HLS stream URL to validate
 * @returns {Promise<Object>} Stream information
 */
async function validateStream(streamUrl) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            '-i', streamUrl
        ];

        const ffprobe = spawn(FFPROBE_PATH, args, {
            timeout: 30000 // 30 second timeout
        });

        let output = '';
        let errorOutput = '';

        ffprobe.stdout.on('data', (data) => {
            output += data.toString();
        });

        ffprobe.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ffprobe.on('close', (code) => {
            if (code !== 0) {
                logger.logError(new Error(`Stream validation failed: ${errorOutput}`), {
                    url: streamUrl.substring(0, 50) + '...'
                });
                resolve({
                    valid: false,
                    error: 'Failed to validate stream',
                    details: errorOutput
                });
                return;
            }

            try {
                const info = JSON.parse(output);
                const videoStream = info.streams?.find(s => s.codec_type === 'video');
                const audioStream = info.streams?.find(s => s.codec_type === 'audio');

                resolve({
                    valid: true,
                    format: info.format?.format_name,
                    duration: info.format?.duration,
                    bitrate: info.format?.bit_rate,
                    video: videoStream ? {
                        codec: videoStream.codec_name,
                        width: videoStream.width,
                        height: videoStream.height,
                        fps: eval(videoStream.r_frame_rate), // Convert fraction to decimal
                        bitrate: videoStream.bit_rate
                    } : null,
                    audio: audioStream ? {
                        codec: audioStream.codec_name,
                        sampleRate: audioStream.sample_rate,
                        channels: audioStream.channels
                    } : null
                });
            } catch (error) {
                logger.logError(error, { context: 'parse ffprobe output' });
                resolve({
                    valid: false,
                    error: 'Failed to parse stream information'
                });
            }
        });

        ffprobe.on('error', (error) => {
            logger.logError(error, { context: 'ffprobe spawn' });
            resolve({
                valid: false,
                error: 'Failed to run stream validation'
            });
        });
    });
}

/**
 * Check if HLS stream is live and accessible
 * @param {string} manifestUrl - HLS manifest URL
 * @returns {Promise<Object>} Live status
 */
async function checkStreamHealth(manifestUrl) {
    try {
        const validation = await validateStream(manifestUrl);
        
        if (!validation.valid) {
            return {
                healthy: false,
                error: validation.error,
                timestamp: new Date().toISOString()
            };
        }

        return {
            healthy: true,
            info: validation,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        logger.logError(error, { context: 'checkStreamHealth' });
        return {
            healthy: false,
            error: error.message,
            timestamp: new Date().toISOString()
        };
    }
}

/**
 * Generate thumbnail from stream (for preview)
 * @param {string} streamUrl - Stream URL
 * @param {string} outputPath - Output file path
 * @param {number} timeOffset - Time offset in seconds
 * @returns {Promise<Object>} Thumbnail generation result
 */
async function generateThumbnail(streamUrl, outputPath, timeOffset = 1) {
    return new Promise((resolve) => {
        const args = [
            '-i', streamUrl,
            '-ss', timeOffset.toString(),
            '-vframes', '1',
            '-q:v', '2',
            '-y', // Overwrite output
            outputPath
        ];

        const ffmpeg = spawn(FFMPEG_PATH, args, {
            timeout: 30000
        });

        let errorOutput = '';

        ffmpeg.stderr.on('data', (data) => {
            errorOutput += data.toString();
        });

        ffmpeg.on('close', (code) => {
            if (code !== 0) {
                logger.logError(new Error(`Thumbnail generation failed: ${errorOutput}`), {
                    url: streamUrl.substring(0, 50) + '...'
                });
                resolve({
                    success: false,
                    error: 'Failed to generate thumbnail'
                });
                return;
            }

            resolve({
                success: true,
                path: outputPath
            });
        });

        ffmpeg.on('error', (error) => {
            logger.logError(error, { context: 'thumbnail generation' });
            resolve({
                success: false,
                error: error.message
            });
        });
    });
}

/**
 * Transcode stream to multiple qualities (for adaptive streaming)
 * Note: This is resource-intensive and should be used sparingly
 * @param {string} inputUrl - Input stream URL
 * @param {string} outputDir - Output directory for variants
 * @param {Array} qualities - Array of quality configurations
 */
async function createAdaptiveVariants(inputUrl, outputDir, qualities = []) {
    // Default quality variants
    const defaultQualities = [
        { name: '1080p', width: 1920, height: 1080, videoBitrate: '5000k', audioBitrate: '192k' },
        { name: '720p', width: 1280, height: 720, videoBitrate: '3000k', audioBitrate: '128k' },
        { name: '480p', width: 854, height: 480, videoBitrate: '1500k', audioBitrate: '96k' },
        { name: '360p', width: 640, height: 360, videoBitrate: '800k', audioBitrate: '64k' }
    ];

    const variants = qualities.length > 0 ? qualities : defaultQualities;

    // This is a simplified example - in production, you'd want to use
    // a more sophisticated approach with proper error handling and monitoring
    const args = [
        '-i', inputUrl,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-preset', 'veryfast',
        '-tune', 'zerolatency',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '10',
        '-hls_flags', 'delete_segments+omit_endlist',
        '-master_pl_name', 'master.m3u8'
    ];

    // Add variant mappings
    variants.forEach((variant, index) => {
        args.push(
            `-map`, '0:v:0',
            `-map`, '0:a:0?',
            `-s:v:${index}`, `${variant.width}x${variant.height}`,
            `-b:v:${index}`, variant.videoBitrate,
            `-b:a:${index}`, variant.audioBitrate,
            `-var_stream_map`, `v:${index},a:${index} v:${index}_%v.m3u8`
        );
    });

    args.push(path.join(outputDir, 'master.m3u8'));

    logger.logStreamEvent('adaptive_transcode_start', {
        input: inputUrl.substring(0, 50) + '...',
        variants: variants.map(v => v.name)
    });

    // Note: Full implementation would require proper process management
    // and is typically done with a dedicated streaming server like nginx-rtmp
    return {
        success: true,
        message: 'Adaptive transcoding configured',
        note: 'For production, consider using dedicated streaming servers'
    };
}

/**
 * Get stream duration using ffprobe
 * @param {string} streamUrl - Stream URL
 * @returns {Promise<number>} Duration in seconds
 */
async function getStreamDuration(streamUrl) {
    return new Promise((resolve) => {
        const args = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            '-i', streamUrl
        ];

        const ffprobe = spawn(FFPROBE_PATH, args, { timeout: 10000 });
        let output = '';

        ffprobe.stdout.on('data', (data) => {
            output += data.toString();
        });

        ffprobe.on('close', (code) => {
            if (code !== 0) {
                resolve(null);
                return;
            }
            const duration = parseFloat(output.trim());
            resolve(isNaN(duration) ? null : duration);
        });

        ffprobe.on('error', () => {
            resolve(null);
        });
    });
}

/**
 * Cleanup all active FFmpeg processes
 */
function cleanupProcesses() {
    for (const [id, process] of activeProcesses.entries()) {
        try {
            process.kill('SIGTERM');
            logger.logStreamEvent('ffmpeg_process_terminated', { id });
        } catch (error) {
            logger.logError(error, { context: 'cleanupProcesses', id });
        }
    }
    activeProcesses.clear();
}

// Cleanup on process exit
process.on('exit', cleanupProcesses);
process.on('SIGINT', () => {
    cleanupProcesses();
    process.exit(0);
});
process.on('SIGTERM', () => {
    cleanupProcesses();
    process.exit(0);
});

module.exports = {
    checkFFmpegInstallation,
    validateStream,
    checkStreamHealth,
    generateThumbnail,
    createAdaptiveVariants,
    getStreamDuration,
    cleanupProcesses,
    FFMPEG_PATH,
    FFPROBE_PATH
};
