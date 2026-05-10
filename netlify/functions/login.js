// netlify/functions/login.js
// Serverless function — validates credentials against users.json
// Deployed to: /.netlify/functions/login  (mapped to /login via _redirects)

const path = require('path');
const fs   = require('fs');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { username, password } = JSON.parse(event.body || '{}');

    // Read users.json relative to project root
    const usersPath = path.join(__dirname, '../../users.json');
    const { users } = JSON.parse(fs.readFileSync(usersPath, 'utf8'));

    const match = users.find(u => u.username === username && u.password === password);

    if (match) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ success: true, username: match.username }),
      };
    } else {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, message: 'ناوی بەکارهێنەر یان وشەی نهێنی هەڵەیە' }),
      };
    }
  } catch (err) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, message: 'داواکاری هەڵەیە' }),
    };
  }
};
