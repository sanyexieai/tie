# 工作区加密 Markdown

加密页面的逻辑正文仍是 Markdown；工作区中的 `pages/<标题>.md` 保存下述密文封套。它沿用普通页面的 id、父级、排序、标题、标签与同步流程，不把解密正文交给普通页面存储。`.tie/history`、离线队列、同步端及打包导出只接收密文。

标题和标签等页面元数据没有加密，仍用于目录和元数据搜索。敏感信息应写在加密正文中。打开后，正文只存在当前编辑器内存中；锁定或离开时销毁编辑器和解密草稿。工作区密码导入为不可导出的 Web Crypto `CryptoKey`，仅在本次应用会话内缓存；密码和密钥不随工作区同步。其他设备需要输入相同密码解锁。忘记密码将无法从密文恢复正文。

## 密文格式 v1

```text
-----BEGIN TIE ENCRYPTED MARKDOWN-----
{"version":1,"algorithm":"AES-256-GCM","kdf":"PBKDF2-SHA256","iterations":600000,"salt":"<Base64>","iv":"<Base64>","ciphertext":"<Base64>"}
-----END TIE ENCRYPTED MARKDOWN-----
```

- 首行是加密类型标记。即使内容损坏，也必须继续按加密页面打开，不能退回普通编辑器展示或保存。
- `salt` 是每次保存生成的 16 字节随机盐；密码使用 UTF-8 字节，经 PBKDF2-HMAC-SHA-256、600,000 次迭代，派生不可导出的 256 位 AES 密钥。
- `iv` 是每次保存重新生成的 12 字节随机值。`ciphertext` 是 AES-GCM 密文与 128 位认证标签的拼接。
- 认证附加数据是 UTF-8 `tie:encrypted-markdown:v1`。它绑定格式用途与版本，不绑定工作区 id，因此原样复制、迁移和跨设备同步的密文仍可用原密码打开。
- v1 只接受上述算法及固定迭代数。盐、iv 和密文严格校验后才运行密钥派生，不能通过文件内容指定任意大的计算量。认证失败不会返回部分正文。
- 文件通常使用 LF，也接受 CRLF 和开头 UTF-8 BOM；正文解密后保留加密前的 Markdown 字节内容（UTF-8）。

这里使用平台内置 [W3C Web Crypto AES-GCM / PBKDF2](https://www.w3.org/TR/webcrypto/)；600,000 次 PBKDF2-HMAC-SHA-256 采用 [OWASP 的 PBKDF2 工作因子基线](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html#pbkdf2)。加密模式选择符合 [OWASP Cryptographic Storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html#cipher-modes) 对认证加密的建议。

## 与服务器凭据库的关系

工作区加密文档和服务器的固定 HTTP 操作凭据是两种数据。旧凭据库的 token/password 仍按原有方式维护和授权，不会自动转成 Markdown 或把整篇文档用作 HTTP 认证值。加密文档默认不向 Agent 提供解密正文；普通页面读取、全文搜索和 MCP 不会获得当前编辑器内存中的明文。
