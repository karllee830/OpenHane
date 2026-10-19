-- 聊天图片：文件在 <数据目录>/chat-images/<room_id>/<image_id>，随消息一起清理
ALTER TABLE chat_messages ADD COLUMN image_id TEXT;
ALTER TABLE chat_messages ADD COLUMN image_width INTEGER;
ALTER TABLE chat_messages ADD COLUMN image_height INTEGER;
ALTER TABLE chat_messages ADD COLUMN image_size INTEGER;
