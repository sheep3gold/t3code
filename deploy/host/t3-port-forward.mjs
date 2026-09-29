// 把桌面端远程环境挑到的端口原样转发到 systemd 管理的唯一 T3 服务。
// 用法：node t3-port-forward.mjs <listenPort> <targetPort>
import net from "node:net";

const listenPort = Number(process.argv[2]);
const targetPort = Number(process.argv[3]);
if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  console.error("usage: t3-port-forward.mjs <listenPort> <targetPort>");
  process.exit(2);
}

const server = net.createServer((client) => {
  const upstream = net.connect(targetPort, "127.0.0.1");
  client.pipe(upstream).pipe(client);
  const close = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", close);
  upstream.on("error", close);
});

server.on("error", (error) => {
  console.error(`t3-port-forward: ${error.message}`);
  process.exit(1);
});
server.listen(listenPort, "127.0.0.1", () => {
  console.error(`t3-port-forward: 127.0.0.1:${listenPort} -> 127.0.0.1:${targetPort}`);
});
