import http from "node:http";

const port = Number(process.argv[2] ?? 4545);
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/hello") {
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ message: "hello" })); return;
  }
  response.writeHead(404); response.end();
});
server.listen(port, "127.0.0.1", () => console.log(`ready:${port}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
