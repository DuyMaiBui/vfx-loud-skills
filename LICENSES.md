# License taxonomy

Mỗi resource **bắt buộc** có `license` (string, server từ chối `unknown`) và mang 2 field
trong `meta` do seed/publish điền theo bảng dưới đây. Đọc hiểu nhanh: `license` nói
*"từ đâu ra"*, `license_class` nói *"dùng lại được tới đâu"*, `ai_training` nói *"huấn
luyện model được không"*.

## `meta.license_class` — mức độ tái sử dụng

| Giá trị | Ý nghĩa | Publish lên cloud? |
| --- | --- | --- |
| `cc0` | Public domain. Dùng commercial, sửa, redistribute, không bắt buộc credit. | ✅ tự do |
| `cc-attribution` | CC-BY / CC-BY-SA. Commercial được, **bắt buộc credit**, share-alike nếu BY-SA. | ✅ kèm `meta.attribution` |
| `proprietary-commercial` | EULA của store (Synty, Asset Store...). Dùng trong game OK, **không được redistribute pack rời**. | ⚠️ chỉ `visibility=project`, payload phải là link/metadata chứ không phải file |
| `restricted` | Không cho redistribute / AI training / chỉ dùng nội bộ. | ❌ không publish |
| `unknown` | Chưa rõ nguồn. | ❌ server reject |

## `meta.ai_training` — trục độc lập (boolean)

| Giá trị | Ý nghĩa |
| --- | --- |
| `true` | Giấy phép cho phép dùng dữ liệu để huấn luyện model (CC0, CC-BY, OGA rõ ràng...). |
| `false` | Không rõ hoặc không cho phép (EULA store thường không nhắc tới → mặc định `false`). |

Không bao giờ suy luận `ai_training=true` từ im lặng. Thiếu bằng chứng → `false`.

## Bảng ánh xạ `license` → class

| `license` | `license_class` | `ai_training` | Ghi chú |
| --- | --- | --- | --- |
| `cc0` | `cc0` | `true` | Kenney, OpenGameArt CC0, tự viết. |
| `cc-by` | `cc-attribution` | `true` | cần `meta.attribution` = tên tác giả. |
| `cc-by-sa` | `cc-attribution` | `true` | share-alike: bản derivative cũng phải CC-BY-SA. |
| `synty-store-eula` | `proprietary-commercial` | `false` | trong-game OK, pack rời không OK. |
| `asset-store-eula` | `proprietary-commercial` | `false` | Unity Asset Store pack không phải Synty (Hovl, Lana, Archanor...). Cùng ràng buộc như `synty-store-eula`. |
| `ai-training-allowed` | theo nguồn | `true` | chỉ dùng khi nguồn ghi rõ. |
| `restricted` | `restricted` | `false` | giữ local. |
| `unknown` | — | `false` | **bị `seed` và `vfx_publish` từ chối.** |

## Quy tắc khi contribute

0. **`license` nói về payload của record, không phải resource mà record tham chiếu.**
   Recipe YAML tự viết trỏ tới texture Synty → recipe là `cc0`, texture vẫn là
   `synty-store-eula`. Mỗi record tự chịu trách nhiệm license của chính bytes của nó.
1. Không bao giờ đặt `license` = `unknown` để "chạy cho qua" — tra nguồn thật, hoặc không contribute.
2. Kenney → `cc0`. OpenGameArt → đọc trang license từng file, ghi đúng dạng (không gộp "OGA").
3. Synty → `synty-store-eula`; pack Asset Store khác → `asset-store-eula`; `visibility=project`, **không upload file binary**, chỉ metadata + path local.
4. Tự viết code/shader/technique → `cc0` + `license_class=cc0`.
5. Khi `license_class` là `proprietary-commercial` trở xuống, payload chỉ được chứa metadata và `vfx://` URI dẫn về máy đã có asset — không chứa bytes của asset.
6. Record trích từ prefab của pack đã mua (`meta.extracted = true`, `seed/extract-unitypackage.ts`) chỉ được mang `synty-store-eula` hoặc `asset-store-eula` (`license_class=proprietary-commercial`, `ai_training=false`, `visibility=project`). Không `cc0`, không `unknown`, không default: `publish()` và extractor đều từ chối. Payload là tham số ParticleSystem; texture/material/shader/mesh chỉ là `{guid, path}`. `meta.source = {pack, vendor, prefabPath, prefabGuid}`.
