-- 聊天图片：文件在 <数据目录>/chat-images/<room_id>/<image_id>，随消息一起清理
ALTER TABLE chat_messages ADD COLUMN image_id TEXT;
ALTER TABLE chat_messages ADD COLUMN image_width INTEGER;
ALTER TABLE chat_messages ADD COLUMN image_height INTEGER;
ALTER TABLE chat_messages ADD COLUMN image_size INTEGER;

-- 端到端加密房间里的聊天：正文是密文（body 为空），发送者的会话 ID 用于接收方找到对应的密钥
ALTER TABLE chat_messages ADD COLUMN sender_session TEXT;
ALTER TABLE chat_messages ADD COLUMN enc_key_index INTEGER;
ALTER TABLE chat_messages ADD COLUMN enc_nonce BLOB;
ALTER TABLE chat_messages ADD COLUMN enc_ciphertext BLOB;
