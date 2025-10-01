# Redis Configuration for SeemueHub Chat Service

This document describes the Redis configuration setup that matches the seemuehub-backend project style.

## Environment Variables

Create a `.env` file in the chat service root with the following variables:

```env
# Server Configuration
PORT=3001
NODE_ENV=development

# Database Configuration
MONGODB_URI=mongodb://localhost:27017/seemuehub-chat

# Redis Configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# Chat Service Configuration
CHAT_SERVICE_URL=http://localhost:3001
CORS_ORIGIN=http://localhost:5173

# Socket Configuration
SOCKET_CORS_ORIGIN=http://localhost:5173
```

## Configuration Features

### 1. **Environment-based Configuration**

- Uses Zod schema validation for environment variables
- Matches the same pattern as seemuehub-backend
- Type-safe environment variable access

### 2. **Redis Connection Management**

- **Graceful Connection**: Automatic retry logic with 3 attempts
- **Error Handling**: Comprehensive error handling for connection failures
- **Safe Publishing**: Won't crash the server if Redis is unavailable
- **Connection Status Tracking**: Monitor Redis connection state

### 3. **Socket.io Integration**

- **Real-time Messaging**: Redis pub/sub for message broadcasting
- **User Status Management**: Online/offline status tracking
- **Conversation Management**: Room-based messaging
- **Order Integration**: Special handling for order-related messages

## Redis Channels

The chat service uses the following Redis channels:

- `SETUP` - User connection setup
- `SEND_MESSAGE` - Message broadcasting
- `READ_MESSAGE` - Message read status
- `USER_OFFLINE` - User disconnection

## Usage

### Import Redis Configuration

```typescript
import { pub, sub, subscribeToClient, redisConfig } from "./config/redis";
```

### Publish Messages

```typescript
// Safe publishing that won't crash if Redis is down
await pub.publish("SEND_MESSAGE", JSON.stringify(messageData));
```

### Check Connection Status

```typescript
if (pub.isConnected()) {
  // Redis is connected and ready
}
```

## Error Handling

The Redis configuration includes comprehensive error handling:

- **Connection Errors**: Automatic retry with exponential backoff
- **Publish Errors**: Safe publishing that logs warnings instead of crashing
- **Subscription Errors**: Graceful handling of subscription failures
- **Network Issues**: Continues operation even if Redis is temporarily unavailable

## Production Considerations

For production deployment:

1. **Set strong Redis password** in `REDIS_PASSWORD`
2. **Use Redis cluster** for high availability
3. **Monitor connection status** using `pub.isConnected()`
4. **Configure proper CORS origins** for your frontend domains
5. **Set appropriate database indexes** for performance

## Integration with SeemueHub Backend

The Redis configuration is designed to work seamlessly with the seemuehub-backend:

- **Same Redis instance**: Both services can share the same Redis server
- **Compatible channels**: Uses the same message format and channels
- **Environment consistency**: Same environment variable naming convention
- **Error handling**: Consistent error handling patterns
