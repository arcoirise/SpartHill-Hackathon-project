# EdgeSense 后端与前端接入契约

这是用于黑客松演示的 FastAPI 服务，配合现有 Next.js 前端。前端文件未改动。

## 启动

需要 Python 3.10 或以上。在仓库根目录执行：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements-dev.txt
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

Windows 激活命令为 `.venv\Scripts\activate`。交互式接口文档：
http://localhost:8000/docs；OpenAPI：`/openapi.json`。开发时可加 `--reload`。
测试从仓库根目录执行 `PYTHONPATH=backend python -m pytest backend/tests -q`。

配置见 `.env.example`，必须通过终端 export / 部署平台环境变量设置；程序不会自动读取 .env。
默认 SQLite 文件相对于启动目录为 `data/edgesense.sqlite3`，默认保留 7 天。
请只启动 **一个 worker、一个实例**：骨架缓存在进程内，多实例不会共享。

本地演示默认不要求访问密钥，因此仅绑定回环地址。远程部署必须设置
`EDGESENSE_API_KEY`，通过 HTTPS 提供 API，并设置 `EDGESENSE_ALLOWED_ORIGINS`
为实际前端源站（多个值逗号分隔）。所有 `/api/v1/*` 请求需携带 `X-API-Key`。
不要将密钥写入仓库或 `NEXT_PUBLIC_*` 构建变量。演示时可在界面输入并只保存在
内存；浏览器持有的密钥仍能被操作人员读取。这是共享演示密钥，不是生产级
用户/角色权限系统。正式使用需加入身份认证、按区域授权、网关限流及访问审计。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活检查，不鉴权 |
| POST | `/api/v1/pose` | 上传一次 33 点骨架，202；空数组清除 |
| GET | `/api/v1/pose/{zone_id}` | 获取服务端实际收到的骨架；无数据/过期返回 204 |
| DELETE | `/api/v1/pose/{zone_id}` | 停止时清除骨架，204 |
| POST | `/api/v1/aggregates` | 保存区域统计，新批次 201，相同批次重试 200，冲突 409 |
| GET | `/api/v1/dashboard?hours=24&zone_id=zone-b` | 区域计数、小时趋势和规则式建议 |

`zone_id` 只接受 1–40 个英文字母、数字、下划线和连字符。查询 hours 范围 1–168。
POST 仅接收 application/json，实际请求体最大 32 KiB；不支持图片、视频、文件上传。
所有模型（含嵌套对象）拒绝未定义字段；错误响应不回显原始请求。

### 左侧上传、右侧从后端读取

```json
{
  "zone_id": "zone-b",
  "landmarks": [
    {"x": 0.5, "y": 0.4, "z": -0.1, "visibility": 0.99}
  ]
}
```

上面仅展示一个点的格式；实际数组必须有 MediaPipe 标准索引顺序的 **33 个点**，
或为 `[]` 表示未检测到人。保留标准索引便于队友绘制骨架。包含脸部关键点，
因此不能声称“不含任何面部数据”；准确说法是“不传输原始图像或视频”。
XYZ 是模型的归一化坐标及相对深度，不是经过校准的物理距离。

建议上传最多每秒 10 次，前一次请求完成后再发下一次，避免堆积与乱序。
右侧每 100–200ms 轮询 GET，并用返回的 landmarks 绘图和显示 JSON。
**不能直接拿左侧 MediaPipe 结果冒充服务端返回值。** GET 204 时清空画布，
网络异常时显示断线，不把旧画面当实时画面。右侧收到 `received_at` 为服务端接收时间。
一个区域同时仅允许一个演示发送源，否则最后到达的数据会覆盖前一个来源。

骨架只存于内存，3 秒后失效，后台每秒检查清理；读取时也会检查过期。
最多同时缓存 100 个区域。暂停/停止时先停止发送循环，再调用 DELETE，
并执行摄像头 `stream.getTracks().forEach(track => track.stop())`。
页面崩溃或退出时依靠 TTL 清理，浏览器退出事件不是可靠的清理机制。

### 区域统计

前端本地累计每 60 秒提交一次（演示可缩短，但不能声称其具备小时聚合的隐私效果）：

```json
{
  "batch_id": "5eeadabc-67b5-4526-8337-8d969b7580c3",
  "zone_id": "zone-b",
  "window_start": "2026-10-23T20:00:00Z",
  "window_seconds": 60,
  "valid_observation_seconds": 48,
  "posture_alert_episodes": 2,
  "heat_alert_episodes": 1,
  "noise_alert_episodes": 0,
  "air_quality_alert_episodes": 0,
  "environment": {
    "source": "simulated",
    "temperature_max_c": 33,
    "noise_max_db": 78,
    "air_quality_max_aqi": 40
  }
}
```

将 window_start 换为当前统计窗口的开始时间，必须带时区且在保留期内。
`batch_id` 用 `crypto.randomUUID()` 生成，失败重试必须使用同一个 ID 和完全相同
的批次内容；成功后再清空这一批次。不同 ID 的重叠窗口不会自动去重，前端应
保证每个区域只有一个汇总源、窗口不重叠。UUID 仅标识批次，不要复用为设备或人员 ID。
警报数统计持续事件的次数，不能每个视频帧都加一次。有效观察秒数不得超过窗口长度。
姿态阈值、冷却期和即时提醒由前端本地处理；服务端不会根据骨架给工人评分。

小时趋势将整个批次归入窗口开始所在的 UTC 小时。dashboard 返回 `zones`、
`hourly`、`recommendations` 和 `notice`。建议由明确规则生成，`source=rule_based`，
不是 LLM 输出或医学判断。环境数据来源会保留在 `environment_sources`，界面必须
显示 simulated 标签；缺少数据时显示空状态，而不是补造历史。

完整 TypeScript 类型及调用封装见 `examples/edgesense-client.ts`，可以复制到前端。
前端本地开发地址默认为 http://localhost:3000，后端为 http://localhost:8000。

## 隐私边界与演示验证

- 视频处理由浏览器实现。后端拒绝视频字段，并不能保证前端没有通过其他服务上传视频；
  联调时要检查浏览器 Network、第三方脚本和部署日志。
- 骨架坐标可能暴露个体动作模式，不能称为完全匿名。本方案是“视频留在本地”的
  演示模式。隐私更强的部署应停止调用 pose 接口，仅发送足够粗粒度的区域统计。
- 数据库仅保存通过验证的统计批次，不保存骨架、摄像头图像或设备/员工标识。
  统计依然可能在单人区域被关联，尚未实施最小群体规模门槛。
- 过期统计每秒逻辑删除；SQLite/WAL、备份及基础设施不保证取证级安全擦除。
  应另行配置磁盘加密和备份保留策略。
- 本应用不记录请求体。Uvicorn/代理可能记录 IP、路径及访问时间；公开演示前检查
  基础设施日志设置。不要把密钥放在 URL 查询参数里。
- 摄像头停止后右侧应在 3 秒内不再获得骨架；重启服务后骨架应为空，统计仍可查询。
- 提醒仅用于演示辅助，不构成经验证的职业健康评估或事故预测。
