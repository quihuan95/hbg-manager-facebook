import sharp from "sharp";
import {
	downloadFileBuffer,
	getFileMetadata,
	listFolderFiles,
} from "../google/drive.js";
import { readMediaBuffer } from "../media.js";

const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const FOLDER_MIME = "application/vnd.google-apps.folder";

// Measured from the transparent opening of the HBG frame.
const FRAME_WIDTH = 2000;
const FRAME_HEIGHT = 2000;
const CONTENT_WIDTH = 1816;
const CONTENT_HEIGHT = 1205;
const CONTENT_LEFT = 93;
const CONTENT_TOP = 420;

export function extractDriveId(value) {
	const raw = String(value || "").trim();
	if (!raw) return null;
	if (/^[a-zA-Z0-9_-]{15,}$/.test(raw)) return raw;
	const match =
		raw.match(/\/folders\/([a-zA-Z0-9_-]+)/) ||
		raw.match(/\/d\/([a-zA-Z0-9_-]+)/) ||
		raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
	if (!match) throw new Error(`Link Google Drive không hợp lệ: ${raw}`);
	return match[1];
}

export async function loadDriveImages(link, maxFiles = 10) {
	const id = extractDriveId(link);
	if (!id) return [];
	const metadata = await getFileMetadata(id);
	const files =
		metadata.mimeType === FOLDER_MIME
			? (await listFolderFiles(id))
					.filter((file) => IMAGE_MIMES.has(file.mimeType))
					.slice(0, maxFiles)
			: [metadata];
	if (!files.length)
		throw new Error(
			"Link nguồn ảnh không chứa file PNG, JPEG hoặc WebP hợp lệ.",
		);
	if (files.some((file) => !IMAGE_MIMES.has(file.mimeType))) {
		throw new Error(
			"Link Drive phải trỏ đến ảnh PNG, JPEG, WebP hoặc thư mục chứa ảnh.",
		);
	}
	return Promise.all(
		files.map(async (file) => ({
			...file,
			buffer: await downloadFileBuffer(file.id),
		})),
	);
}

export async function composeFrame(imageBuffer, frameBuffer) {
	if (!imageBuffer || !frameBuffer)
		throw new Error("Thiếu dữ liệu ảnh hoặc khung ảnh.");

	// Preserve the complete source image. A blurred copy fills any small
	// letterbox area while the sharp foreground uses `contain`, so no people,
	// text, or other important content is cropped by the frame ratio.
	const background = await sharp(imageBuffer)
		.rotate()
		.resize(CONTENT_WIDTH, CONTENT_HEIGHT, { fit: "cover", position: "centre" })
		.blur(24)
		.png()
		.toBuffer();
	const foreground = await sharp(imageBuffer)
		.rotate()
		.resize(CONTENT_WIDTH, CONTENT_HEIGHT, {
			fit: "contain",
			background: { r: 255, g: 255, b: 255, alpha: 0 },
		})
		.png()
		.toBuffer();
	const content = await sharp(background)
		.composite([{ input: foreground, left: 0, top: 0 }])
		.png()
		.toBuffer();
	const overlay = await sharp(frameBuffer)
		.rotate()
		.resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: "fill" })
		.png()
		.toBuffer();
	const output = await sharp({
		create: {
			width: FRAME_WIDTH,
			height: FRAME_HEIGHT,
			channels: 4,
			background: { r: 255, g: 255, b: 255, alpha: 1 },
		},
	})
		.composite([
			{ input: content, left: CONTENT_LEFT, top: CONTENT_TOP },
			{ input: overlay, left: 0, top: 0 },
		])
		.png()
		.toBuffer();
	return output;
}

export async function applyDriveFrame(imageData, frameLink) {
	if (!String(frameLink || "").trim()) return imageData;
	const [frame] = await loadDriveImages(frameLink, 1);
	const imageBuffer = readMediaBuffer(imageData);
	if (!imageBuffer) throw new Error("Không đọc được ảnh cần lắp khung.");
	const output = await composeFrame(imageBuffer, frame.buffer);
	return `data:image/png;base64,${output.toString("base64")}`;
}
