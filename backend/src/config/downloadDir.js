import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Thư mục chứa file do admin kéo thả thủ công. Có thể ghi đè bằng DOWNLOAD_DIR trong .env */
export const DOWNLOAD_DIR = path.resolve(
  process.env.DOWNLOAD_DIR || path.join(__dirname, '../../download'),
);
