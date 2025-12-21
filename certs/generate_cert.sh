#!/bin/bash
# 生成自签名证书

# 生成私钥
openssl genrsa -out key.pem 2048

# 生成证书签名请求
openssl req -new -key key.pem -out csr.pem 

# 生成自签名证书
openssl x509 -req -days 365 -in csr.pem -signkey key.pem -out cert.pem

# 清理临时文件
rm csr.pem

echo "✅ 自签名证书生成完成!"
echo "证书文件: ./cert.pem"
echo "私钥文件: ./key.pem"
echo ""
echo "⚠️  注意: 自签名证书需要在浏览器中手动信任"
echo "生产环境请使用 Let's Encrypt 或商业证书"