import http from "node:http";
import url from "node:url";
import { handler } from "./handler.js";
import "dotenv/config";

const PORT = process.env.PORT || 3000;

// Traducimos una request local (http) al "event" que espera API Gateway (Lambda proxy)
const server = http.createServer(async (req, res) => {
  try {
    const parsed = url.parse(req.url, true);
    const event = {
      rawPath: parsed.pathname,
      path: parsed.pathname,
      httpMethod: req.method,
      headers: req.headers,
      queryStringParameters: parsed.query,
      body: null,
      isBase64Encoded: false
    };

    const result = await handler(event);

    res.statusCode = result.statusCode || 200;
    if (result.headers) {
      Object.entries(result.headers).forEach(([k, v]) => res.setHeader(k, v));
    }
    res.end(result.body || "");
  } catch (e) {
    console.error(e);
    res.statusCode = 500;
    res.end("Internal Error");
  }
});

server.listen(PORT, () => {
  console.log(`Local API running on http://localhost:${PORT}`);
  console.log(`Try: GET http://localhost:${PORT}/images-by-date?date=20250101`);
});
