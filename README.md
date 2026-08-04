# 简仓

本地库存、销售预留和送货管理网页。

## 本地运行

需要 Node.js 22 或更新版本。

```bash
npm install
npm run dev
```

打开终端显示的本地地址，通常是 `http://localhost:3000`。

本地库存、订单和操作日志保存在本地 D1 数据库中。关闭网页或重启电脑不会丢失。

## 功能

- 销售提交订单后自动设为 Pending
- 采购安排送货后生成司机消息，并通过 Gmail SMTP 自动发送订单详情
- 司机确认送达后扣减实际库存
- 采购用自然语言整理新货，确认后入库
- 操作日志记录销售、安排送货、送达和入库

## 推送前检查

```bash
npm run build
```

## Gmail 邮件通知

Gmail 账户需要先开启两步验证，再创建一个 App Password。不要使用 Gmail 登录密码，也不要把 App Password 写进代码或提交到 GitHub。

线上部署前，把发件邮箱和 App Password 保存为 Cloudflare Secrets：

```bash
npx wrangler secret put GMAIL_SMTP_USER
npx wrangler secret put GMAIL_SMTP_APP_PASSWORD
```

安排送货时填写司机邮箱。任务保存成功后，系统会直接连接 Gmail SMTP，自动发送包含送货日期、客户、电话、地址、商品、备注和销售人员的预设邮件。邮件发送失败不会取消已经保存的送货任务，页面和操作日志会显示失败状态。

项目当前没有绑定任何线上 Sites 项目，可以自行推送或部署。
