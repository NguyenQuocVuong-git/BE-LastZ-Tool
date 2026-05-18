import { Router } from 'express';
import { listDownloadFiles, resolveDownloadFile } from '../utils/downloadFiles.js';

const router = Router();

/**
 * GET /download
 * Danh sách file trong thư mục download (public, không cần đăng nhập).
 */
router.get('/', async (req, res) => {
  try {
    const files = await listDownloadFiles();
    return res.json({ success: true, data: { files } });
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Lỗi máy chủ.',
    });
  }
});

/**
 * GET /download/:filename
 * Tải xuống một file theo tên (public, không cần đăng nhập).
 */
router.get('/:filename', async (req, res) => {
  try {
    const resolved = await resolveDownloadFile(req.params.filename);
    if (!resolved) {
      return res.status(404).json({
        success: false,
        code: 'FILE_NOT_FOUND',
        message: 'Không tìm thấy file.',
      });
    }

    return res.download(resolved.fullPath, resolved.name);
  } catch (e) {
    console.error(e);
    return res.status(500).json({
      success: false,
      code: 'INTERNAL_ERROR',
      message: 'Lỗi máy chủ.',
    });
  }
});

export default router;
