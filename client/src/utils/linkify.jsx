import React from 'react';

/**
 * Detects URLs in text and converts them to clickable <a> links.
 * Handles http(s), www., and bare domain patterns.
 * Safe — no dangerouslySetInnerHTML, returns React elements.
 */
const URL_REGEX = /(https?:\/\/[^\s<>"{}|\\^`[\]]+|www\.[^\s<>"{}|\\^`[\]]+\.[^\s<>"{}|\\^`[\]]+)/gi;

export function linkifyText(text) {
  if (!text || typeof text !== 'string') return text;

  const parts = [];
  let lastIndex = 0;
  let match;

  // Reset regex state
  URL_REGEX.lastIndex = 0;

  while ((match = URL_REGEX.exec(text)) !== null) {
    // Add text before the URL
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    let url = match[0];
    // Strip trailing punctuation that's likely not part of the URL
    const trailingPunct = /[.,;:!?)]+$/.exec(url);
    let suffix = '';
    if (trailingPunct) {
      suffix = trailingPunct[0];
      url = url.slice(0, -suffix.length);
    }

    const href = url.startsWith('http') ? url : `https://${url}`;
    const displayUrl = url.length > 50 ? url.slice(0, 47) + '...' : url;

    parts.push(
      <a
        key={match.index}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: 'var(--accent-color)', textDecoration: 'underline' }}
        onClick={(e) => e.stopPropagation()}
      >
        {displayUrl}
      </a>
    );

    if (suffix) {
      parts.push(suffix);
    }

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last URL
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}
