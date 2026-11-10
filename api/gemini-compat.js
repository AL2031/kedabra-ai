// Gemini 3 requires thought signatures to be echoed with the original
// OpenAI-compatible tool_call. Keep this helper independent of the API route
// so the streaming/serialization behavior can be regression-tested.

function mergeObjects(target, source) {
  const output = { ...(target && typeof target === 'object' ? target : {}) };
  if (!source || typeof source !== 'object' || Array.isArray(source)) return output;
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      output[key] = mergeObjects(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

export function mergeProviderToolCall(call, delta) {
  const extra = delta?.extra_content || delta?.extraContent;
  if (extra && typeof extra === 'object') {
    call.extra_content = mergeObjects(call.extra_content, extra);
  }

  // Support both the documented OpenAI-compat shape and the naming variants
  // exposed by some streaming adapters. The canonical request field remains
  // extra_content.google.thought_signature.
  const signature = delta?.google?.thought_signature
    || delta?.google?.thoughtSignature
    || delta?.thought_signature
    || delta?.thoughtSignature;
  if (typeof signature === 'string' && signature.length) {
    call.extra_content = mergeObjects(call.extra_content, {
      google: { thought_signature: signature },
    });
  }
  return call;
}

export function hasGoogleThoughtSignature(call) {
  const signature = call?.extra_content?.google?.thought_signature
    || call?.extraContent?.google?.thought_signature;
  return typeof signature === 'string' && signature.length > 0;
}

// Google-only signatures must be returned to Google unchanged. They are not
// meaningful to Groq, so remove only that provider-specific subtree on fallback.
export function messagesForProvider(messages, provider) {
  if (provider === 'google') return messages;
  return (messages || []).map(message => {
    if (!message || typeof message !== 'object') return message;
    let changed = false;
    const next = { ...message };
    if (next.extra_content?.google) {
      next.extra_content = { ...next.extra_content };
      delete next.extra_content.google;
      if (!Object.keys(next.extra_content).length) delete next.extra_content;
      changed = true;
    }
    if (Array.isArray(next.tool_calls)) {
      next.tool_calls = next.tool_calls.map(call => {
        if (!call?.extra_content?.google) return call;
        const extra = { ...call.extra_content };
        delete extra.google;
        const clean = { ...call };
        if (Object.keys(extra).length) clean.extra_content = extra;
        else delete clean.extra_content;
        changed = true;
        return clean;
      });
    }
    return changed ? next : message;
  });
}

export function isRetryableProviderStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}
