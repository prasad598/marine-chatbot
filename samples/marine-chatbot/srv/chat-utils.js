// srv/chat-utils.js
'use strict';

function normalizeInvoiceNumber(rawValue) {
  if (rawValue === undefined || rawValue === null) return '';
  const digitsOnly = `${rawValue}`.replace(/\D/g, '').trim();
  if (!digitsOnly) return '';
  const truncated = digitsOnly.length > 10 ? digitsOnly.slice(-10) : digitsOnly;
  return truncated.padStart(10, '0');
}

function extractInvoiceNumberFromText(text) {
  if (!text) return '';
  const matches = `${text}`.match(/\d+/g);
  if (!matches || matches.length === 0) return '';
  matches.sort((a, b) => b.length - a.length);
  return matches[0] || '';
}

module.exports = {
  normalizeInvoiceNumber,
  extractInvoiceNumberFromText
};
