import os
import json
import math
import subprocess
import time
from PIL import Image, ImageDraw, ImageFont

from anim_scenes import (
    draw_organic_dev, draw_animated_robot, draw_token_fire,
    draw_tra_da_table, draw_multi_device_ecosystem,
    draw_active_pencil_test, draw_spam_recommend_barrage,
    draw_overloaded_mind, draw_chibi_overloaded_dev
)

FFMPEG = 'C:/Users/tungh/AppData/Local/Programs/Python/Python310/lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v9.0.2.exe'

WIDTH = 1080
HEIGHT = 1920
FPS = 30

# Load Fonts
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_STICKER = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 32)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

TOTAL_DURATION = 67.0
TOTAL_FRAMES = int(TOTAL_DURATION * FPS)

# Load Mockups & Badges
DOODLES_DIR = 'video/assets/doodles'
MOCKUPS_DIR = 'video/assets/mockups'

def safe_load(path):
    if os.path.exists(path):
        return Image.open(path).convert('RGBA')
    return None

ASSETS = {
    'mockup_phone_1': safe_load(os.path.join(MOCKUPS_DIR, 'mockup_phone_1.png')),
    'mockup_phone_2': safe_load(os.path.join(MOCKUPS_DIR, 'mockup_phone_2.png')),
    'stamp_hitl_10': safe_load(os.path.join(DOODLES_DIR, 'stamp_hitl_10.png')),
    'badge_remotecli': safe_load(os.path.join(DOODLES_DIR, 'badge_remotecli.png')),
    'doodle_hand': safe_load(os.path.join(DOODLES_DIR, 'doodle_hand.png')),
}

# Subtitle Segments with highlighted keywords
SUBTITLES = [
    # Scene 1
    (0.0, 4.2, "Có một nghịch lý: AI càng làm được nhiều việc...", "NGHỊCH LÝ"),
    (4.2, 8.8, "...thì ta lại càng bận hơn chứ chẳng được ngồi chơi!", "CÀNG BẬN HƠN"),
    (8.8, 11.5, "Thấy AI cày khỏe, bạn đốt token cho đỡ phí quota...", "ĐỐT TOKEN"),
    (11.5, 14.5, "Nhưng trong lúc nó chạy, vẫn phải ngồi canh HITL!", "HITL"),
    # Scene 2
    (14.5, 18.5, "Ngồi máy mãi đau lưng, bạn remote qua điện thoại...", "REMOTE ĐIỆN THOẠI"),
    (18.5, 22.8, "Chat chỉ đạo AI như nhắn tin với người yêu!", "NHƯ NHẮN TIN GHỆ"),
    (22.8, 27.4, "Thế là ngồi trà đá vỉa hè cũng mở ra làm việc!", "TRÀ ĐÁ VỈA HÈ"),
    # Scene 3
    (27.4, 31.5, "Thấy cái PC ở nhà bỏ không, lôi ra cày ý tưởng cũ...", "HỒI SINH PC"),
    (31.5, 35.8, "Thêm con laptop cũ, thêm một con VPS trên mây...", "LAPTOP + VPS"),
    (35.8, 39.7, "Gom hết vào RemoteCLI, chuyển máy chỉ bằng 1 cái tab!", "CHUYỂN MÁY 1 TAB"),
    # Scene 4
    (39.7, 43.5, "Từ 1 project, giờ bạn ôm cùng lúc 5-6 cái!", "5-6 PROJECTS"),
    (43.5, 47.7, "Hàng chục session nhảy liên tục từ sáng đến chiều...", "47 SESSIONS"),
    # Scene 5
    (47.7, 51.5, "Và rồi... đầu óc bạn bắt đầu phân mảnh!", "PHÂN MẢNH CONTEXT"),
    (51.5, 55.5, "Cả đàn AI thi nhau réo xin duyệt quyền...", "XIN DUYỆT QUYỀN"),
    (55.5, 58.7, "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!", "BẤM RECOMMEND"),
    # Scene 6
    (58.7, 62.5, "Hóa ra từ sáng đến đêm chỉ làm bài thi trắc nghiệm...", "BÀI THI TRẮC NGHIỆM"),
    (62.5, 66.5, "Bạn còn bận hơn cả lúc chưa có AI!", "BẬN HƠN CHƯA CÓ AI"),
]

def get_current_subtitle(t):
    for start, end, text, keyword in SUBTITLES:
        if start <= t < end:
            return text, keyword
    return "", ""

def overlay_image(base, overlay, pos):
    if overlay is None:
        return
    base.paste(overlay, pos, overlay)

def render_frame(frame_idx):
    t = frame_idx / FPS

    # 1. Base Whiteboard Paper Background
    im = Image.new('RGBA', (WIDTH, HEIGHT), (250, 250, 248, 255))
    draw = ImageDraw.Draw(im)

    # Double hand-drawn doodle border
    draw.rectangle((24, 24, WIDTH - 24, HEIGHT - 24), outline='#cbd5e1', width=3)
    draw.rectangle((20, 20, WIDTH - 20, HEIGHT - 20), outline='#1e293b', width=4)

    # Top Header Banner
    draw.rounded_rectangle((60, 45, WIDTH - 60, 120), radius=16, fill='#ffffff', outline='#0f172a', width=4)
    draw.text((85, 60), "RemoteCLI • Chuyện Nghề Dev", fill='#0f172a', font=FONT_TITLE)
    # Online blinking green status dot
    green_r = 12 + int(math.sin(t * 8) * 2)
    draw.ellipse((WIDTH - 110, 82 - green_r//2, WIDTH - 110 + green_r, 82 + green_r//2), fill='#22c55e', outline='#0f172a', width=2)

    # ==========================================
    # SCENE CHOREOGRAPHY
    # ==========================================
    if t < 14.54:
        # === SCENE 1: Nghịch Lý AI & HITL ===
        # Badge entrance
        badge_y = 150 + int(math.sin(min(1.0, t / 0.6) * math.pi * 0.5) * 20)
        draw.rounded_rectangle((100, badge_y, WIDTH - 100, badge_y + 80), radius=16, fill='#e0e7ff', outline='#4338ca', width=5)
        draw.text((140, badge_y + 18), "CÓ MỘT NGHỊCH LÝ: CÀNG CÓ AI...", fill='#3730a3', font=FONT_TITLE)

        # Left: Frantic typing robot with steam & sparks
        draw_animated_robot(draw, 330, 680, scale=1.35, t=t)

        # Right: Stressed dev scratching head, knocking knees
        draw_organic_dev(draw, 780, 700, scale=1.35, pose='standing_stressed', t=t)

        # Center Bottom: Token Fire
        draw_token_fire(draw, 540, 1140, scale=1.4, t=t)

        # Stickers appearing on cue
        if t >= 4.5:
            st_scale = min(1.0, (t - 4.5) / 0.4)
            st_w = int(580 * st_scale)
            st_box = ((WIDTH - st_w) // 2, 1280, (WIDTH + st_w) // 2, 1360)
            draw.rounded_rectangle(st_box, radius=16, fill='#fef08a', outline='#0f172a', width=5)
            if st_scale >= 0.9:
                draw.text(((WIDTH - 520) // 2, 1300), "ĐỐT TOKEN CHO ĐỠ PHÍ QUOTA!", fill='#0f172a', font=FONT_BOLD)

        if t >= 9.0:
            hitl_y = 1390 + int(math.sin((t - 9.0) * 12) * 5)
            draw.rounded_rectangle((100, hitl_y, WIDTH - 100, hitl_y + 80), radius=16, fill='#fee2e2', outline='#ef4444', width=5)
            draw.text((140, hitl_y + 18), "CHUẨN HITL: PHẢI NGỒI CANH TỪNG TÝ!", fill='#b91c1c', font=FONT_BOLD)

    elif t < 27.43:
        # === SCENE 2: Remote Trà Đá Vỉa Hè ===
        t_scene = t - 14.54

        # Top Badge
        draw.rounded_rectangle((100, 150, WIDTH - 100, 230), radius=16, fill='#dcfce7', outline='#16a34a', width=5)
        draw.text((140, 170), "TRÀ ĐÁ VỈA HÈ & REMOTE TỪ XA", fill='#15803d', font=FONT_TITLE)

        # Left: Dev sitting on low plastic stool, foot tapping, thumbs typing
        draw_organic_dev(draw, 380, 880, scale=1.45, pose='sitting_tra_da', t=t)

        # Right: Trà đá crate table, iced tea glass with curling vapor, sunflower seeds
        draw_tra_da_table(draw, 780, 880, scale=1.35, t=t)

        # Speech Bubble 1: "Ghé trà đá làm cốc đi anh!"
        if t_scene >= 1.5:
            draw.rounded_rectangle((110, 270, 560, 350), radius=18, fill='#e0f2fe', outline='#0284c7', width=4)
            draw.text((140, 290), "Ghé trà đá làm cốc đi anh!", fill='#0369a1', font=FONT_SUBTITLE)
            draw.polygon([(200, 350), (220, 350), (190, 380)], fill='#e0f2fe')
            draw.line([(200, 350), (190, 380), (220, 350)], fill='#0284c7', width=4)

        # Speech Bubble 2: "Đang remote AI... như nhắn tin với ghệ!"
        if t_scene >= 4.0:
            draw.rounded_rectangle((WIDTH - 640, 390, WIDTH - 100, 480), radius=18, fill='#dcfce7', outline='#16a34a', width=4)
            draw.text((WIDTH - 610, 410), "Chat AI như nhắn tin với ghệ!", fill='#15803d', font=FONT_SUBTITLE)
            draw.polygon([(WIDTH - 250, 480), (WIDTH - 230, 480), (WIDTH - 240, 510)], fill='#dcfce7')
            draw.line([(WIDTH - 250, 480), (WIDTH - 240, 510), (WIDTH - 230, 480)], fill='#16a34a', width=4)

        # Punchline Badge: "ĐANG YÊN ĐANG LÀNH TỰ NHIÊN GÁNH THÊM VIỆC!"
        if t_scene >= 7.5:
            punch_box = (80, 1180, WIDTH - 80, 1290)
            draw.rounded_rectangle(punch_box, radius=20, fill='#fee2e2', outline='#ef4444', width=6)
            draw.text((110, 1210), "TỰ NHIÊN LẠI GÁNH THÊM VIỆC!", fill='#b91c1c', font=FONT_HERO)

    elif t < 39.69:
        # === SCENE 3: Hồi Sinh Máy Cũ & 1-Tab Switcher ===
        t_scene = t - 27.43

        # Top Banner
        draw.rounded_rectangle((80, 150, WIDTH - 80, 235), radius=18, fill='#e0e7ff', outline='#4338ca', width=5)
        draw.text((120, 175), "HỒI SINH MÁY BÀN + LAPTOP + VPS", fill='#3730a3', font=FONT_TITLE)

        # Ecosystem Cluster with cables, CRT sparks, VPS rain, and 1-Tab switcher
        draw_multi_device_ecosystem(draw, 540, 740, scale=1.25, t=t)

        # Big Highlight Sticker
        if t_scene >= 4.0:
            box = (100, 1180, WIDTH - 100, 1290)
            draw.rounded_rectangle(box, radius=20, fill='#ffffff', outline='#0066FF', width=6)
            draw.text((130, 1205), "CHUYỂN MÁY CHỈ BẰNG 1 CÁI TAB!", fill='#0066FF', font=FONT_HERO)

    elif t < 47.68:
        # === SCENE 4: Bùng Nổ Project (Chuyển thể Ảnh 1) ===
        t_scene = t - 39.69

        # Top Alert
        draw.rounded_rectangle((70, 150, WIDTH - 70, 240), radius=18, fill='#ffedd5', outline='#ea580c', width=5)
        draw.text((100, 175), "TỪ 1 PROJECT -> THÀNH 5-6 PROJECT CÙNG LÚC!", fill='#c2410c', font=FONT_TITLE)

        # Phone Mockup 1 (Screenshot of sessions & tabs)
        phone_1 = ASSETS['mockup_phone_1']
        if phone_1:
            p_scaled = phone_1.resize((560, 1140), Image.Resampling.LANCZOS)
            p_x = (WIDTH - 560) // 2
            p_y = 280
            overlay_image(im, p_scaled, (p_x, p_y))

            # Animated focus highlight on tabs: [Local] [Home-PC] [Laptop]
            tab_step = int((t_scene * 1.6) % 3)
            tab_boxes = [
                (290, 475, 375, 515), # Local
                (380, 475, 500, 515), # Home-PC
                (505, 475, 610, 515), # Laptop
            ]
            cur_box = tab_boxes[tab_step]
            draw.rounded_rectangle(cur_box, radius=8, outline='#facc15', width=5)

            # Finger tap animation
            hand = ASSETS['doodle_hand']
            if hand and t_scene > 0.8:
                hand_x = cur_box[0] + 15
                hand_y = cur_box[1] + 15 + int(math.sin(t_scene * 8) * 8)
                overlay_image(im, hand, (hand_x, hand_y))
                ripple_r = int((t_scene * 28) % 22)
                draw.circle((cur_box[0] + 45, cur_box[1] + 20), ripple_r, outline='#38bdf8', width=3)

        # Project bubbles floating around
        proj_tags = [
            ("OTA: 2 sess", 35, 480, '#ef4444'),
            ("Sandbox: 2 sess", WIDTH - 265, 560, '#3b82f6'),
            ("Temp: 2 sess", 35, 750, '#10b981'),
            ("UAV: 47 sess", WIDTH - 250, 840, '#f59e0b'),
        ]
        for p_name, px, py, p_col in proj_tags:
            bob = math.sin(t_scene * 4 + px) * 6
            tw = len(p_name) * 15 + 28
            draw.rounded_rectangle((px, py + bob, px + tw, py + bob + 55), radius=12, fill='#ffffff', outline=p_col, width=4)
            draw.text((px + 14, py + bob + 12), p_name, fill=p_col, font=FONT_BOLD)

        # Badge: UAV 47 SESSIONS!
        if t_scene >= 3.0:
            draw.rounded_rectangle((WIDTH - 440, 1180, WIDTH - 60, 1265), radius=14, fill='#ef4444', outline='#0f172a', width=4)
            draw.text((WIDTH - 415, 1198), "UAV: 47 SESSIONS!", fill='#ffffff', font=FONT_BOLD)

    elif t < 58.74:
        # === SCENE 5: Phân Mảnh Não Bộ & Phone Mockup 2 (PowerShell & 90 Tin Nhắn) ===
        t_scene = t - 47.68
        shake = int(math.sin(t_scene * 28) * 3)

        # Top Banner
        draw.rounded_rectangle((80 + shake, 150, WIDTH - 80 + shake, 235), radius=18, fill='#fee2e2', outline='#ef4444', width=5)
        draw.text((120 + shake, 175), "ĐẦU ÓC PHÂN MẢNH VÌ QUÁ NHIỀU CONTEXT!", fill='#b91c1c', font=FONT_TITLE)

        # Center: Phone Mockup 2 (Active PowerShell terminal, 126k tokens, 90 unread messages)
        phone_2 = ASSETS['mockup_phone_2']
        if phone_2:
            p_w, p_h = 500, 1040
            p_scaled = phone_2.resize((p_w, p_h), Image.Resampling.LANCZOS)
            p_x = (WIDTH - p_w) // 2 + shake
            p_y = 265
            overlay_image(im, p_scaled, (p_x, p_y))

            # Target reticle highlighting the "90" unread notification badge on the screen
            badge_x = p_x + 185
            badge_y = p_y + 880
            draw.ellipse((badge_x - 18, badge_y - 18, badge_x + 18, badge_y + 18), outline='#ef4444', width=4)
            for ang in [0, 90, 180, 270]:
                rad = math.radians(ang)
                draw.line([(badge_x + math.cos(rad) * 22, badge_y + math.sin(rad) * 22), (badge_x + math.cos(rad) * 32, badge_y + math.sin(rad) * 32)], fill='#ef4444', width=3)

        # Upper Left: Chibi Overloaded Dev with rotating spiral eyes and steam from ears
        draw_chibi_overloaded_dev(draw, 145, 360, scale=1.1, t=t)

        # Floating Panic Tags Left
        tags_left = [
            ("90 TIN NHẮN!", 25, 520, '#ef4444', '#fee2e2', 0.0),
            ("126K TOKENS!", 25, 680, '#ea580c', '#ffedd5', 0.8),
            ("Sửa config.ts?", 25, 840, '#d97706', '#fef3c7', 1.6),
        ]
        for text, tx, ty, border_c, bg_c, delay in tags_left:
            if t_scene >= delay:
                tw = len(text) * 16 + 28
                bob = math.sin(t_scene * 5 + tx) * 5
                draw.rounded_rectangle((tx, ty + bob, tx + tw, ty + bob + 54), radius=12, fill=bg_c, outline=border_c, width=3)
                draw.text((tx + 14, ty + bob + 12), text, fill=border_c, font=FONT_BOLD)
                draw.line([(tx + tw, ty + bob + 27), (tx + tw + 25, ty + bob + 27)], fill=border_c, width=3)
                draw.polygon([(tx + tw + 25, ty + bob + 27), (tx + tw + 18, ty + bob + 22), (tx + tw + 18, ty + bob + 32)], fill=border_c)

        # Floating Panic Tags Right
        tags_right = [
            ("Duyệt lệnh bash?", 790, 360, '#0284c7', '#e0f2fe', 0.4),
            ("Git conflict!", 810, 520, '#7c3aed', '#ede9fe', 1.2),
            ("Xin quyền root?", 795, 680, '#0891b2', '#cffafe', 2.0),
            ("47 SESSIONS!", 805, 840, '#dc2626', '#fee2e2', 2.8),
        ]
        for text, tx, ty, border_c, bg_c, delay in tags_right:
            if t_scene >= delay:
                tw = len(text) * 16 + 28
                bob = math.sin(t_scene * 5 + tx) * 5
                draw.rounded_rectangle((tx, ty + bob, tx + tw, ty + bob + 54), radius=12, fill=bg_c, outline=border_c, width=3)
                draw.text((tx + 14, ty + bob + 12), text, fill=border_c, font=FONT_BOLD)
                draw.line([(tx - 25, ty + bob + 27), (tx, ty + bob + 27)], fill=border_c, width=3)
                draw.polygon([(tx - 25, ty + bob + 27), (tx - 18, ty + bob + 22), (tx - 18, ty + bob + 32)], fill=border_c)

        # Transition to spamming Recommend (t_scene >= 5.0s)
        if t_scene >= 5.0:
            # Lower Center: Anime Flurry Barrage smashing Recommend Button
            draw_spam_recommend_barrage(draw, 540, 1180, scale=1.2, t=t)

            # Warning Sticker
            draw.rounded_rectangle((100, 1360, WIDTH - 100, 1440), radius=16, fill='#fef08a', outline='#0f172a', width=4)
            draw.text((140, 1378), "TOÀN NHẮM MẮT BẤM RECOMMEND KHỎI NGHĨ!", fill='#0f172a', font=FONT_BOLD)

    else:
        # === SCENE 6: Cái Kết: Bài Thi Trắc Nghiệm ===
        t_scene = t - 58.74

        if t_scene < 4.2:
            # Title banner
            draw.rounded_rectangle((80, 130, WIDTH - 80, 215), radius=16, fill='#fee2e2', outline='#ef4444', width=5)
            draw.text((120, 150), "CẢ NGÀY CHỈ LÀM BÀI TRẮC NGHIỆM!", fill='#b91c1c', font=FONT_TITLE)

            # Active Pencil Test Sheet (Questions with pencil actively circling Recommend)
            draw_active_pencil_test(draw, 540, 680, scale=1.15, t=t_scene)

            # Slumped Exhausted Dev with spiral eyes and cute soul ghost
            draw_organic_dev(draw, 540, 1360, scale=1.2, pose='dizzy_slumped', t=t)

            # Rubber Stamp Slam at t_scene >= 2.0s
            if t_scene >= 2.0:
                stamp_img = ASSETS['stamp_hitl_10']
                if stamp_img:
                    rotated_stamp = stamp_img.rotate(-6, expand=True, resample=Image.Resampling.BICUBIC)
                    rw, rh = rotated_stamp.size
                    stamp_progress = min(1.0, (t_scene - 2.0) / 0.25)
                    slam_offset = int((1.0 - stamp_progress) * 40)
                    overlay_image(im, rotated_stamp, ((WIDTH - rw) // 2 + 10, 680 - slam_offset))
        else:
            # Final Punchline & RemoteCLI Outro Card
            overlay_image(im, ASSETS['badge_remotecli'], ((WIDTH - 600) // 2, 360))

            draw.rounded_rectangle((80, 580, WIDTH - 80, 860), radius=24, fill='#ffffff', outline='#0066FF', width=6)
            draw.text((140, 620), "BẬN HƠN CẢ KHI CHƯA CÓ AI!", fill='#ef4444', font=FONT_HERO)
            draw.text((115, 700), "RemoteCLI: Giải phóng máy tính,", fill='#0f172a', font=FONT_TITLE)
            draw.text((115, 755), "nhưng đừng để AI quản lý lại bạn!", fill='#0066FF', font=FONT_TITLE)

            # Low stool & Iced tea glass
            draw_tra_da_table(draw, 540, 1080, scale=1.3, t=t)

    # ========================================================
    # DYNAMIC ANIMATED SUBTITLE CARD (At bottom of every frame)
    # ========================================================
    sub_text, sub_keyword = get_current_subtitle(t)
    if sub_text:
        card_box = (60, 1680, WIDTH - 60, 1850)
        shadow_box = (64, 1684, WIDTH - 56, 1854)
        draw.rounded_rectangle(shadow_box, radius=22, fill='#94a3b8')
        draw.rounded_rectangle(card_box, radius=22, fill='#ffffff', outline='#0f172a', width=5)

        if sub_keyword:
            kw_box = (85, 1700, 85 + len(sub_keyword) * 20 + 20, 1740)
            draw.rounded_rectangle(kw_box, radius=8, fill='#fef08a', outline='#0f172a', width=3)
            draw.text((95, 1708), sub_keyword, fill='#0f172a', font=FONT_SM)
            draw.text((85, 1760), sub_text, fill='#0f172a', font=FONT_TITLE)
        else:
            draw.text((85, 1740), sub_text, fill='#0f172a', font=FONT_TITLE)

    return im.convert('RGB')

def main():
    out_video = 'video/output/remote-cli-doodle.mp4'
    soundtrack = 'video/assets/audio/soundtrack_master.wav'

    print(f"Starting video rendering to {out_video}...")
    t_start = time.time()

    cmd = [
        FFMPEG, '-y',
        '-f', 'rawvideo',
        '-vcodec', 'rawvideo',
        '-s', f'{WIDTH}x{HEIGHT}',
        '-pix_fmt', 'rgb24',
        '-r', str(FPS),
        '-i', '-',
        '-i', soundtrack,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '19',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-pix_fmt', 'yuv420p',
        out_video
    ]

    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

    for frame_idx in range(TOTAL_FRAMES):
        frame_img = render_frame(frame_idx)
        proc.stdin.write(frame_img.tobytes())

        if (frame_idx + 1) % 150 == 0 or frame_idx == TOTAL_FRAMES - 1:
            elapsed = time.time() - t_start
            fps_speed = (frame_idx + 1) / elapsed
            percent = (frame_idx + 1) / TOTAL_FRAMES * 100
            print(f"Rendered {frame_idx + 1}/{TOTAL_FRAMES} frames ({percent:.1f}%) - Speed: {fps_speed:.1f} fps")

    proc.stdin.close()
    stderr = proc.stderr.read()
    proc.wait()

    total_time = time.time() - t_start
    if proc.returncode == 0:
        file_size = os.path.getsize(out_video) / (1024 * 1024)
        print(f"SUCCESS: Rendered {out_video} ({file_size:.2f} MB) in {total_time:.1f}s")
    else:
        print(f"ERROR rendering video. Return code: {proc.returncode}")
        print(stderr.decode('utf-8', errors='ignore'))

if __name__ == '__main__':
    main()
