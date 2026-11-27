import { fileURLToPath } from "node:url";
import { createLocalAccount } from "./local-auth.mjs";

const accountPath = fileURLToPath(new URL("./data/admin-account.json", import.meta.url));
const input = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 1024) throw new Error("Password input is too long.");
  input.push(chunk);
}
const password = Buffer.concat(input).toString("utf8").replace(/\r?\n$/, "");
try {
  await createLocalAccount(accountPath, password);
  console.log("管理员账号已创建。打开 http://127.0.0.1:8790/admin 登录。");
} catch (error) {
  console.error(error.code === "EEXIST" ? "管理员账号已存在。" : error.message);
  process.exitCode = 1;
}
