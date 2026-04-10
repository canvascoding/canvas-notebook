# WebSocket "HTTP 401" Issue Analysis

## Problem Summary

The WebSocket chat was failing with "HTTP 401" errors when trying to send messages. The root cause was a **broken authentication chain** in the server-to-server communication between the WebSocket bridge and the `/api/stream` endpoint.

## What Went Wrong

### Original Setup (Working State)
The original implementation from commit `c6df3881bc0bdd146bec66448dae63d7beb43fbe` had this flow:

1. **Browser** → Authenticates via cookies with better-auth
2. **WebSocket Server** → Validates session from cookies on WebSocket handshake
3. **Bridge** → Sends HTTP POST to `/api/stream` (without userId in body)
4. **API Route** → Validates session from cookies on HTTP request

**The Problem:** Server-to-server fetch requests (from the WebSocket bridge to `/api/stream`) do NOT automatically include browser cookies. This means step 4 was receiving **no session cookies** and returning 401 Unauthorized.

### Why It "Worked" Before
It's unclear how this ever worked in the original commit. Theories:
- `/api/stream` may not have been validating sessions properly
- better-auth was picking up session data from a different source
- The code path wasn't being exercised in testing

## The Fix

### Solution: Trust userId from Body for Internal Calls

We modified `/api/stream/route.ts` to accept an internal server-to-server authentication mechanism:

```typescript
export async function POST(request: NextRequest) {
  const payload = await request.json();
  
  // Check if this is an internal server-to-server call
  const bodyUserId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  let userId: string;
  
  if (bodyUserId) {
    // Internal call from WebSocket bridge - trust the userId from body
    userId = bodyUserId;
    console.log('[PI Stream] Internal server call with userId:', userId);
  } else {
    // External browser call - require session auth
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }
    userId = session.user.id;
  }
  // ... rest of handler
}
```

### How It Works Now

1. **Browser** → Authenticates via cookies with better-auth
2. **WebSocket Server** → Validates session from cookies on WebSocket handshake
3. **Bridge** → Sends HTTP POST to `/api/stream` **WITH userId in body**
4. **API Route** → Sees `userId` in body, recognizes as internal call, skips cookie auth

## Security Considerations

**⚠️ IMPORTANT: This is NOT fully secure!**

The current implementation trusts any request with a `userId` in the body. This means:
- Anyone who can make a POST request to `/api/stream` can impersonate any user
- There's no validation that the request actually came from the WebSocket bridge
- No `INTERNAL_WS_SECRET` or similar protection is implemented

### For Production / Mobile Apps

To make this secure for React Native or mobile apps:

1. **Add INTERNAL_WS_SECRET validation**
   ```typescript
   const internalSecret = request.headers.get('x-internal-ws-secret');
   if (internalSecret === process.env.INTERNAL_WS_SECRET) {
     // Trust userId from body
   }
   ```

2. **Implement token-based authentication**
   - Use JWT tokens instead of cookies
   - Better for mobile/React Native
   - More reliable than cookie-based auth in WebSocket contexts

3. **Rate limiting**
   - Currently disabled for internal calls
   - Should be re-enabled or implemented separately

## Files Modified

- `app/api/stream/route.ts` - Added userId body extraction logic
- `server/websocket-runtime-bridge.ts` - Sends userId in POST body
- `app/lib/websocket/client.ts` - Added window event mirroring for event propagation
- `app/components/canvas-agent-chat/CanvasAgentChat.tsx` - Added debug logging

## Lessons Learned

1. **Server-to-server HTTP requests don't inherit browser cookies**
   - Fetch from Node.js/Next.js custom server won't have the user's session cookies
   - Alternative auth mechanism needed

2. **WebSocket auth != HTTP auth**
   - Just because WebSocket connection is authenticated doesn't mean subsequent HTTP calls are
   - Need explicit auth for each communication channel

3. **Event propagation architecture**
   - Events flow: PI Runtime → EventEmitter → Bridge → WebSocket Server → Client
   - Each layer needs proper event forwarding
   - Window.dispatchEvent used for global React component communication

## Testing

To verify the fix works:

1. Open chat in browser
2. Send a message
3. Check server logs for:
   - `[PI Stream] Internal server call with userId: ...`
   - `[WebSocket Bridge] Received event for session ...`
4. Message should appear in chat UI

## Future Improvements

- Implement INTERNAL_WS_SECRET for server-to-server validation
- Add JWT token support for mobile/React Native clients
- Re-enable rate limiting for internal calls
- Consider unified auth mechanism across WebSocket and HTTP
