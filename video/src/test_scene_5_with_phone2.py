import math
from PIL import Image, ImageDraw, ImageFont
from anim_scenes import (
    draw_organic_dev, draw_spam_recommend_barrage,
    draw_overloaded_mind, INK, SKIN, SHIRT
)

WIDTH = 1080
HEIGHT = 1920

FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44)
FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_SUBTITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 26)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

phone_2_img = Image.open('video/assets/mockups/mockup_phone_2.png').convert('RGBA')

def overlay_image(base, overlay, pos):
    if overlay is None:
        return
    base.paste(overlay, pos, overlay)

def render_scene_5_test(t_scene=2.0):
    t = 47.68 + t_scene
    im = Image.new('RGBA', (WIDTH, HEIGHT), (250, 250, 248, 255))
    draw = ImageDraw.Draw(im)

    # Double hand-drawn doodle border
    draw.rectangle((24, 24, WIDTH - 24, HEIGHT - 24), outline='#cbd5e1', width=3)
    draw.rectangle((20, 20, WIDTH - 20, HEIGHT - 20), outline='#1e293b', width=4)

    # Top Header Banner
    draw.rounded_rectangle((60, 45, WIDTH - 60, 120), radius=16, fill='#ffffff', outline='#0f172a', width=4)
    draw.text((85, 60), "RemoteCLI • Chuyện Nghề Dev", fill='#0f172a', font=FONT_TITLE)
    green_r = 12 + int(math.sin(t * 8) * 2)
    draw.ellipse((WIDTH - 110, 82 - green_r//2, WIDTH - 110 + green_r, 82 + green_r//2), fill='#22c55e', outline='#0f172a', width=2)

    # Top Scene Banner
    shake = int(math.sin(t_scene * 26) * 4)
    draw.rounded_rectangle((80 + shake, 150, WIDTH - 80 + shake, 235), radius=18, fill='#fee2e2', outline='#ef4444', width=5)
    draw.text((120 + shake, 175), "ĐẦU ÓC PHÂN MẢNH VÌ QUÁ NHIỀU CONTEXT!", fill='#b91c1c', font=FONT_TITLE)

    # Center: Phone Mockup 2 (PowerShell prompt, 126k tokens, 90 messages)
    pw, ph = 520, 1080
    p_x = (WIDTH - pw) // 2 + shake
    p_y = 265
    overlay_image(im, phone_2_img, (p_x, p_y))

    # Doodle Callout on Phone: Glowing indicator on "90" unread messages badge
    badge_pulse = int(math.sin(t_scene * 12) * 4)
    # The 90 badge is around (p_x + 180, p_y + 920) on the screen
    # Draw an animated doodle circle around 90 messages with arrow pointing to it
    draw.ellipse((p_x + 165 - badge_pulse, p_y + 910 - badge_pulse, p_x + 205 + badge_pulse, p_y + 950 + badge_pulse), outline='#ef4444', width=3)

    # Left & Right Floating Project Panic Badges
    floating_tags = [
        ("🚨 90 TIN NHẮN!", 40, 360, '#ef4444', 0.0),
        ("🔥 126K TOKENS!", 40, 540, '#f97316', 0.8),
        ("⚠️ Sửa config.ts?", 40, 720, '#eab308', 1.6),
        ("⚡ Duyệt lệnh bash?", WIDTH - 290, 420, '#3b82f6', 0.4),
        ("💥 Git conflict!", WIDTH - 270, 600, '#a855f7', 1.2),
        ("❓ Xin quyền root?", WIDTH - 280, 780, '#06b6d4', 2.0),
    ]

    for tag_text, tag_x, tag_y, tag_col, delay in floating_tags:
        if t_scene >= delay:
            bob = math.sin(t_scene * 5 + tag_x) * 6
            tw = len(tag_text) * 16 + 25
            draw.rounded_rectangle((tag_x, tag_y + bob, tag_x + tw, tag_y + bob + 55), radius=12, fill='#ffffff', outline=tag_col, width=4)
            draw.text((tag_x + 14, tag_y + bob + 12), tag_text, fill=tag_col, font=FONT_BOLD)
            # Small doodle connection lines pointing towards phone
            if tag_x < WIDTH // 2:
                draw.line([(tag_x + tw, tag_y + bob + 27), (tag_x + tw + 25, tag_y + bob + 27)], fill=tag_col, width=3)
            else:
                draw.line([(tag_x - 25, tag_y + bob + 27), (tag_x, tag_y + bob + 27)], fill=tag_col, width=3)

    # Upper Left: Overloaded Dev Head with spiral eyes & smoking ears
    draw_overloaded_mind(draw, 160, 1040, scale=0.85, t=t)

    # When voice transitions to "Toàn nhắm mắt bấm Recommend vì không kịp nghĩ!" (t_scene >= 5.0)
    if t_scene >= 5.0:
        # Slam the big Recommend button with anime flurry barrage
        btn_y = 1180
        draw_spam_recommend_barrage(draw, WIDTH // 2, btn_y, scale=1.2, t=t)

        # Warning Sticker at bottom
        draw.rounded_rectangle((100, 1360, WIDTH - 100, 1440), radius=16, fill='#fef08a', outline='#0f172a', width=4)
        draw.text((140, 1378), "TOÀN NHẮM MẮT BẤM RECOMMEND KHỎI NGHĨ!", fill='#0f172a', font=FONT_BOLD)

    # Subtitle Card
    card_box = (60, 1680, WIDTH - 60, 1850)
    shadow_box = (64, 1684, WIDTH - 56, 1854)
    draw.rounded_rectangle(shadow_box, radius=22, fill='#94a3b8')
    draw.rounded_rectangle(card_box, radius=22, fill='#ffffff', outline='#0f172a', width=5)

    kw_box = (85, 1700, 85 + 14 * 20 + 20, 1740)
    draw.rounded_rectangle(kw_box, radius=8, fill='#fef08a', outline='#0f172a', width=3)
    draw.text((95, 1708), "XIN DUYỆT QUYỀN", fill='#0f172a', font=FONT_SM)
    draw.text((85, 1760), "Cả đàn AI thi nhau réo xin duyệt quyền...", fill='#0f172a', font=FONT_TITLE)

    return im.convert('RGB')

if __name__ == '__main__':
    im_a = render_scene_5_test(t_scene=2.5)
    im_a.save('video/test_scene_5_phone2_early.png')
    im_b = render_scene_5_test(t_scene=6.5)
    im_b.save('video/test_scene_5_phone2_late.png')
    print("Saved test images!")
