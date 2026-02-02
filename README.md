# Live Streaming Platform

A production-ready live video streaming platform with secure HLS proxy and token-based authentication.

## Features

- **Secure HLS Proxy**: Protects original stream URLs with encryption
- **Token-Based Access**: JWT tokens with configurable expiry
- **Viewer Tracking**: Real-time viewer count and session management
- **Quality Selection**: Adaptive bitrate streaming support
- **Chrome Optimized**: Full compatibility with Chrome and modern browsers
- **Low Latency**: HLS.js configuration for minimal delay
- **Scalable Design**: Supports multiple concurrent viewers

## Architecture

### Why HLS over WebRTC?

1. **Better Scalability**: HLS uses HTTP/CDN infrastructure
2. **Native Browser Support**: Works via hls.js without plugins
3. **Adaptive Bitrate**: Built-in ABR for varying network conditions
4. **Firewall Friendly**: Works through corporate proxies
5. **Lower Server Complexity**: Ideal for one-to-many broadcasts
6. **DVR Support**: Easy recording and playback
7. **Chrome Excellence**: Superior HLS.js support in Chrome

## File Structure

```
live-streaming-platform/
├── server.js           # Main Express server
├── auth.js             # JWT authentication & token management
├── streamProxy.js      # HLS proxy with CORS handling
├── ffmpeg.js           # FFmpeg integration for stream validation
├── logger.js           # Winston logging configuration
├── token.json          # Token configuration (JWT secrets)
├── package.json        # Dependencies
├── .env.example        # Environment variables template
├── public/
│   ├── index.html      # Stream link generator page
│   └── player.html     # Video player page
└── logs/               # Application logs (auto-created)
```

## Quick Start

### Prerequisites

- Node.js 18+ 
- FFmpeg (optional, for stream validation)

### Installation

```bash
# Clone or extract the project
cd live-streaming-platform

# Install dependencies
npm install

# Configure environment (optional)
cp .env.example .env
# Edit .env with your settings

# Start the server
npm start
```

### Development Mode

```bash
npm run dev
```

## Usage

### 1. Generate Stream Link

1. Open `http://localhost:3000`
2. Paste your HLS (.m3u8) URL
3. Select expiry duration
4. Click "Generate Live Link"
5. Copy the generated link

### 2. Watch Stream

1. Open the generated link in Chrome
2. Stream auto-plays
3. Use controls: Fullscreen, Quality, Share

### 3. API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/generate` | POST | Generate stream link |
| `/api/validate` | GET | Validate token |
| `/api/stats/:id` | GET | Stream statistics |
| `/api/stop` | POST | Stop stream |
| `/api/streams` | GET | List active streams |
| `/health` | GET | Health check |

### Generate Link API

```bash
curl -X POST http://localhost:3000/api/generate \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com/stream.m3u8",
    "expiryMinutes": 120
  }'
```

Response:
```json
{
  "success": true,
  "data": {
    "token": "eyJhbG...",
    "streamId": "abc123...",
    "expiresAt": "2024-01-15T10:00:00Z",
    "viewerUrl": "http://localhost:3000/player.html?token=...&sid=...",
    "expiresIn": "2 hours"
  }
}
```

## Configuration

### token.json

```json
{
  "jwt": {
    "secret": "your-secret-key-min-32-chars",
    "expiresIn": "2h",
    "issuer": "live-streaming-platform"
  },
  "stream": {
    "defaultExpiryMinutes": 120,
    "maxConcurrentViewers": 1000
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `NODE_ENV` | development | Environment |
| `JWT_SECRET` | - | JWT signing key |
| `CORS_ORIGIN` | * | Allowed origins |
| `LOG_LEVEL` | info | Logging level |

## FFmpeg Setup

### Ubuntu/Debian
```bash
sudo apt update
sudo apt install ffmpeg
```

### macOS
```bash
brew install ffmpeg
```

### Windows
Download from: https://ffmpeg.org/download.html

### Verify Installation
```bash
ffmpeg -version
```

## Deployment

### Render.com

1. Push code to GitHub
2. Create New Web Service on Render
3. Connect repository
4. Set environment variables
5. Deploy

### VPS (Ubuntu)

```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install FFmpeg
sudo apt install ffmpeg

# Clone and setup
git clone <your-repo>
cd live-streaming-platform
npm install --production

# Setup PM2
sudo npm install -g pm2
pm2 start server.js --name "streaming-platform"
pm2 startup
pm2 save

# Setup Nginx (optional)
sudo apt install nginx
# Configure reverse proxy to port 3000
```

### Docker

```dockerfile
FROM node:18-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
```

## Chrome Compatibility

### Tested On
- Chrome 120+ (Windows, macOS, Linux)
- Chrome Android (latest)

### Required Features
- Media Source Extensions (MSE)
- Fetch API
- Promise support
- ES6+ JavaScript

### HLS.js Configuration
```javascript
{
  maxBufferLength: 30,
  liveSyncDurationCount: 3,
  lowLatencyMode: true,
  enableWorker: true
}
```

## Security

### Implemented
- JWT token authentication
- URL encryption in tokens
- CORS protection
- Rate limiting
- Helmet security headers
- Token expiry and revocation
- Viewer session tracking

### Best Practices
- Use HTTPS in production
- Store JWT secrets securely
- Regular dependency updates
- Log monitoring
- Input validation

## Scalability

### Current
- In-memory stream store
- Single server deployment
- 1000 max concurrent viewers per stream

### Scaling Options

1. **Redis**: Replace in-memory store
2. **Load Balancer**: Multiple server instances
3. **CDN**: Cache segments at edge
4. **Dedicated Streaming**: Use nginx-rtmp for high load

### Redis Integration
```javascript
// Replace auth.js maps with Redis
const Redis = require('ioredis');
const redis = new Redis(process.env.REDIS_URL);
```

## Monitoring

### Logs
```bash
# View logs
tail -f logs/combined.log

# View errors
tail -f logs/error.log
```

### Health Check
```bash
curl http://localhost:3000/health
```

### Metrics
- Active streams
- Viewer count per stream
- Token validation rate
- Proxy cache hit rate

## Troubleshooting

### Stream Not Loading
1. Check HLS URL is accessible
2. Verify token not expired
3. Check browser console for errors
4. Validate CORS headers

### High Latency
1. Reduce `liveSyncDurationCount`
2. Enable `lowLatencyMode`
3. Check network conditions
4. Use CDN for segments

### Token Errors
1. Verify JWT secret matches
2. Check token expiry time
3. Ensure clock synchronization
4. Validate token format

## License

MIT

## Support

For issues and feature requests, please create an issue in the repository.
