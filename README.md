# 海信智能客服 Portal

独立的海信冰箱客服页面，通过服务端调用已发布的扣子资源库对话流 `7528646254000488498`，默认关联海信冰箱售后客服智能体 `7527602171085504564`。支持订单物流、支付和售后咨询，连续对话会把最近的消息整理为对话流的 `robot_history`。页面不会存放扣子令牌，也不会在调用失败时展示模拟答案。

## 启动

需要 Node.js 22 或更新版本。

```bash
npm install
cp .env.example .env
# 编辑 .env，填入具有 workflow run 权限的 COZE_ACCESS_TOKEN
npm start
```

打开 <http://localhost:3005>。如需更换关联智能体，可在 `.env` 中设置 `COZE_BOT_ID`。该智能体需已发布到 API 渠道。

### macOS 常驻运行

配置 `.env` 后执行 `sh ops/install-macos-service.sh`。系统登录时会启动 Portal，进程异常退出后由 `launchd` 自动拉起。默认仅监听 `127.0.0.1:3005`，避免局域网用户直接调用并消耗扣子额度。

运行状态可用 `curl -fsS http://127.0.0.1:3005/health` 检查。返回 `expiresSoon: true` 表示令牌将在 7 天内到期；到期后需更换 `.env` 中的令牌并重启服务。服务日志位于 `~/Library/Logs/haixin-cs-portal.out.log` 和 `~/Library/Logs/haixin-cs-portal.err.log`。

更换令牌或修改代码后，用 `launchctl kickstart -k gui/$(id -u)/com.haixin.cs-portal` 重启服务；用 `launchctl print gui/$(id -u)/com.haixin.cs-portal` 查看托管状态。

服务端还限制同时运行的咨询为 8 个、单个客户端每分钟 20 次、全局每分钟 100 次、扣子响应为 1 MiB，并对超时和客户端断开连接及时释放请求。忙时会返回可重试的错误，Portal 保留用户的问题供重发。

### Ubuntu + Docker 部署

服务器安装 Docker Compose 后，克隆仓库，在项目目录创建权限为 `0600` 的 `.env`（至少设置 `COZE_ACCESS_TOKEN` 和 `COZE_TOKEN_EXPIRES_AT`），然后执行 `docker compose up -d --build`。容器会在异常退出后自动重启；`docker compose ps` 可查看健康状态。Compose 默认发布 TCP 3005，需在云防火墙中单独放行此端口。请勿把 `.env` 提交到 Git。

## 接口映射

浏览器只调用本地 `POST /api/chat`。服务端将信息发送到 [扣子执行对话流 API](https://docs.coze.cn/developer_guides_workflow_chat)：

| 对话流输入 | Portal 来源 |
| --- | --- |
| `additional_messages` / `USER_INPUT` | 当前问题 |
| `conversation_id` | 扣子返回的会话 ID，用于连续对话 |
| `product_info` | 冰箱型号；未填写时使用“具体型号暂未提供” |
| `robot_history` | 最近 16 条会话消息，加上当前问题 |

对话流返回 SSE 事件，服务端读取已完成的 `answer` 消息作为客服回复。扣子令牌只在服务器环境变量中读取。

## 验证

```bash
npm test
```

2026-09-26 已使用已发布的工作流 v0.0.7 完成真实 API 验证：Portal 页面可以取得扣子回答，并支持连续对话。令牌保存在本机 `.env`，有效期至 2026-10-26；到期后需要更新服务端令牌并重启 Portal。
