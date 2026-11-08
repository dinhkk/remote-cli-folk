import math
import random
from PIL import Image, ImageDraw, ImageFont
from spline_art import catmull_rom_spline, draw_smooth_curve

FONT_TITLE = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 36)
FONT_BOLD = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 28)
FONT_REGULAR = ImageFont.truetype('C:/Windows/Fonts/segoeui.ttf', 24)
FONT_HERO = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 44)
FONT_STICKER = ImageFont.truetype('C:/Windows/Fonts/arialbd.ttf', 32)
FONT_SM = ImageFont.truetype('C:/Windows/Fonts/segoeuib.ttf', 20)

INK = '#1e293b'
SKIN = '#ffedd5'
SHIRT = '#38bdf8'
PANTS = '#334155'
SLIPPER = '#facc15'

# ==========================================
# 1. THE CHARMING DEV CHARACTER RIG
# ==========================================
def draw_charming_dev(draw, cx, cy, scale=1.0, pose='sitting_tra_da', t=0.0):
    """
    Renders an expressive, organic, cartoon doodle dev.
    pose: 'sitting', 'sitting_tra_da', 'standing_stressed', 'dizzy_slumped'
    """
    breathe = math.sin(t * 3.5) * 4 * scale
    sway = math.cos(t * 2.5) * 3 * scale

    if pose in ('sitting', 'sitting_tra_da'):
        # --- SITTING ON VIETNAMESE PLASTIC STOOL AT TRÀ ĐÁ ---
        stool_w, stool_h = 160 * scale, 75 * scale
        stool_y = cy + 110 * scale

        # 1. Plastic Stool (Ghế nhựa thấp Duy Tân/Song Long)
        seat_box = (cx - stool_w/2, stool_y, cx + stool_w/2, stool_y + 26 * scale)
        draw.rounded_rectangle(seat_box, radius=int(8 * scale), fill='#0284c7', outline=INK, width=int(5 * scale))
        draw.ellipse((cx - 18 * scale, stool_y + 8 * scale, cx + 18 * scale, stool_y + 18 * scale), fill='#0369a1', outline=INK, width=int(2 * scale))

        leg_pts = [
            [(cx - 65 * scale, stool_y + 26 * scale), (cx - 78 * scale, stool_y + stool_h)],
            [(cx - 30 * scale, stool_y + 26 * scale), (cx - 38 * scale, stool_y + stool_h - 5 * scale)],
            [(cx + 30 * scale, stool_y + 26 * scale), (cx + 38 * scale, stool_y + stool_h - 5 * scale)],
            [(cx + 65 * scale, stool_y + 26 * scale), (cx + 78 * scale, stool_y + stool_h)],
        ]
        for lp in leg_pts:
            draw.line(lp, fill=INK, width=int(6 * scale))
            draw.line(lp, fill='#0284c7', width=int(4 * scale))
        draw.line([(cx - 72 * scale, stool_y + 50 * scale), (cx + 72 * scale, stool_y + 50 * scale)], fill=INK, width=int(5 * scale))

        # 2. Hips & Shorts
        hip_y = stool_y - 10 * scale + breathe
        shorts_pts = [
            (cx - 55 * scale, hip_y - 25 * scale),
            (cx - 65 * scale, hip_y + 25 * scale),
            (cx - 15 * scale, hip_y + 35 * scale),
            (cx, hip_y + 18 * scale),
            (cx + 15 * scale, hip_y + 35 * scale),
            (cx + 65 * scale, hip_y + 25 * scale),
            (cx - 55 * scale, hip_y - 25 * scale),
        ]
        draw_smooth_curve(draw, shorts_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=PANTS)

        # 3. Legs & Honeycomb Slippers
        ground_y = stool_y + stool_h + 10 * scale

        # Left Leg (Resting firmly on ground with knee and calf curve)
        knee_l_x = cx - 45 * scale
        knee_l_y = hip_y + 45 * scale
        foot_l_x = cx - 50 * scale
        foot_l_y = ground_y

        draw_smooth_curve(draw, [(cx - 30 * scale, hip_y + 10 * scale), (knee_l_x, knee_l_y), (foot_l_x, foot_l_y - 10 * scale)], fill=INK, width=int(22 * scale))
        draw_smooth_curve(draw, [(cx - 30 * scale, hip_y + 10 * scale), (knee_l_x, knee_l_y), (foot_l_x, foot_l_y - 10 * scale)], fill=SKIN, width=int(14 * scale))

        draw.rounded_rectangle((foot_l_x - 22 * scale, foot_l_y - 12 * scale, foot_l_x + 22 * scale, foot_l_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK, width=int(4 * scale))
        for hx in [-14, -5, 5, 14]:
            draw.point((foot_l_x + hx * scale, foot_l_y - 2 * scale), fill='#ca8a04')

        # Right Leg (Excited foot tapping: "nhịp giò"!)
        tap = math.sin(t * 14) * 16 * scale
        knee_r_x = cx + 45 * scale
        knee_r_y = hip_y + 45 * scale + tap * 0.3
        foot_r_x = cx + 55 * scale
        foot_r_y = ground_y + tap

        draw_smooth_curve(draw, [(cx + 30 * scale, hip_y + 10 * scale), (knee_r_x, knee_r_y), (foot_r_x, foot_r_y - 10 * scale)], fill=INK, width=int(22 * scale))
        draw_smooth_curve(draw, [(cx + 30 * scale, hip_y + 10 * scale), (knee_r_x, knee_r_y), (foot_r_x, foot_r_y - 10 * scale)], fill=SKIN, width=int(14 * scale))

        draw.rounded_rectangle((foot_r_x - 22 * scale, foot_r_y - 12 * scale, foot_r_x + 24 * scale, foot_r_y + 8 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK, width=int(4 * scale))
        for hx in [-12, -3, 6, 15]:
            draw.point((foot_r_x + hx * scale, foot_r_y - 2 * scale), fill='#ca8a04')

        if tap < -4 * scale:
            draw.arc((foot_r_x - 25 * scale, ground_y - 4 * scale, foot_r_x + 30 * scale, ground_y + 18 * scale), start=0, end=180, fill='#94a3b8', width=int(3 * scale))

        # 4. Torso
        chest_y = hip_y - 120 * scale
        torso_pts = [
            (cx - 45 * scale + sway, chest_y),
            (cx - 58 * scale + sway, chest_y + 60 * scale),
            (cx - 52 * scale + sway, hip_y),
            (cx, hip_y + 8 * scale),
            (cx + 52 * scale + sway, hip_y),
            (cx + 58 * scale + sway, chest_y + 60 * scale),
            (cx + 45 * scale + sway, chest_y),
            (cx + sway, chest_y - 10 * scale),
        ]
        draw_smooth_curve(draw, torso_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=SHIRT)
        draw.arc((cx - 18 * scale + sway, chest_y - 16 * scale, cx + 18 * scale + sway, chest_y + 4 * scale), start=0, end=180, fill=INK, width=int(4 * scale))

        # 5. Head & Expression
        head_cx = cx + sway * 0.8
        head_cy = chest_y - 75 * scale + breathe * 0.5
        head_r = 52 * scale

        # Ears
        draw.ellipse((head_cx - head_r - 6 * scale, head_cy - 8 * scale, head_cx - head_r + 12 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(4 * scale))
        draw.ellipse((head_cx + head_r - 12 * scale, head_cy - 8 * scale, head_cx + head_r + 6 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(4 * scale))

        head_pts = [
            (head_cx - head_r, head_cy),
            (head_cx - head_r + 5 * scale, head_cy - 40 * scale),
            (head_cx, head_cy - 52 * scale),
            (head_cx + head_r - 5 * scale, head_cy - 40 * scale),
            (head_cx + head_r, head_cy),
            (head_cx + head_r - 10 * scale, head_cy + 42 * scale),
            (head_cx, head_cy + 52 * scale),
            (head_cx - head_r + 10 * scale, head_cy + 42 * scale),
        ]
        draw_smooth_curve(draw, head_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=SKIN)

        hair_pts = [
            (head_cx - head_r - 8 * scale, head_cy - 10 * scale),
            (head_cx - head_r - 4 * scale, head_cy - 50 * scale),
            (head_cx - 25 * scale, head_cy - 72 * scale),
            (head_cx, head_cy - 75 * scale),
            (head_cx + 30 * scale, head_cy - 70 * scale),
            (head_cx + head_r + 6 * scale, head_cy - 45 * scale),
            (head_cx + head_r + 4 * scale, head_cy - 10 * scale),
            (head_cx + 35 * scale, head_cy - 30 * scale),
            (head_cx + 10 * scale, head_cy - 38 * scale),
            (head_cx - 15 * scale, head_cy - 35 * scale),
            (head_cx - 38 * scale, head_cy - 28 * scale)
        ]
        draw_smooth_curve(draw, hair_pts, fill=INK, width=int(6 * scale), closed=True, fill_color='#1e293b')

        # Cheerful Smiling Eyes ^_^
        draw_smooth_curve(draw, [(head_cx - 28 * scale, head_cy - 4 * scale), (head_cx - 18 * scale, head_cy - 14 * scale), (head_cx - 8 * scale, head_cy - 4 * scale)], fill=INK, width=int(4 * scale))
        draw_smooth_curve(draw, [(head_cx + 8 * scale, head_cy - 4 * scale), (head_cx + 18 * scale, head_cy - 14 * scale), (head_cx + 28 * scale, head_cy - 4 * scale)], fill=INK, width=int(4 * scale))

        draw.ellipse((head_cx - 38 * scale, head_cy + 6 * scale, head_cx - 16 * scale, head_cy + 22 * scale), fill='#fecdd3')
        draw.ellipse((head_cx + 16 * scale, head_cy + 6 * scale, head_cx + 38 * scale, head_cy + 22 * scale), fill='#fecdd3')
        draw_smooth_curve(draw, [(head_cx - 16 * scale, head_cy + 18 * scale), (head_cx, head_cy + 28 * scale), (head_cx + 16 * scale, head_cy + 18 * scale)], fill='#ef4444', width=int(4 * scale))

        # 6. Arms holding smartphone
        phone_cx = cx + sway
        phone_cy = chest_y + 45 * scale

        elbow_l = (cx - 62 * scale + sway, chest_y + 35 * scale)
        hand_l = (phone_cx - 28 * scale, phone_cy + 12 * scale)
        draw_smooth_curve(draw, [(cx - 45 * scale + sway, chest_y + 15 * scale), elbow_l, hand_l], fill=INK, width=int(14 * scale))
        draw_smooth_curve(draw, [(cx - 45 * scale + sway, chest_y + 15 * scale), elbow_l, hand_l], fill=SKIN, width=int(9 * scale))

        elbow_r = (cx + 62 * scale + sway, chest_y + 35 * scale)
        hand_r = (phone_cx + 28 * scale, phone_cy + 12 * scale)
        draw_smooth_curve(draw, [(cx + 45 * scale + sway, chest_y + 15 * scale), elbow_r, hand_r], fill=INK, width=int(14 * scale))
        draw_smooth_curve(draw, [(cx + 45 * scale + sway, chest_y + 15 * scale), elbow_r, hand_r], fill=SKIN, width=int(9 * scale))

        pw, ph = 54 * scale, 90 * scale
        draw.rounded_rectangle((phone_cx - pw/2, phone_cy - ph/2, phone_cx + pw/2, phone_cy + ph/2), radius=int(8 * scale), fill='#0284c7', outline=INK, width=int(4 * scale))
        draw.rounded_rectangle((phone_cx - pw/2 + 4 * scale, phone_cy - ph/2 + 5 * scale, phone_cx + pw/2 - 4 * scale, phone_cy + ph/2 - 5 * scale), radius=int(5 * scale), fill='#e0f2fe')
        draw.rounded_rectangle((phone_cx - 18 * scale, phone_cy - 28 * scale, phone_cx + 10 * scale, phone_cy - 14 * scale), radius=int(3 * scale), fill='#38bdf8')
        draw.rounded_rectangle((phone_cx - 10 * scale, phone_cy - 8 * scale, phone_cx + 18 * scale, phone_cy + 6 * scale), radius=int(3 * scale), fill='#22c55e')

        tap_l = math.sin(t * 18) * 5 * scale
        tap_r = math.cos(t * 18) * 5 * scale
        draw.ellipse((phone_cx - 24 * scale, phone_cy + tap_l, phone_cx - 8 * scale, phone_cy + 16 * scale + tap_l), fill=SKIN, outline=INK, width=int(3 * scale))
        draw.ellipse((phone_cx + 8 * scale, phone_cy + tap_r, phone_cx + 24 * scale, phone_cy + 16 * scale + tap_r), fill=SKIN, outline=INK, width=int(3 * scale))

        for p_i, p_off in enumerate([0.0, 0.5]):
            p_t = (t * 0.8 + p_off) % 1.0
            float_y = p_t * 100 * scale
            float_x = (35 + p_i * 20) * scale + math.sin((t + p_off) * 4) * 10 * scale
            draw.arc((phone_cx + float_x - 10 * scale, phone_cy - 40 * scale - float_y - 10 * scale, phone_cx + float_x + 10 * scale, phone_cy - 40 * scale - float_y + 10 * scale), start=0, end=360, fill='#0284c7', width=int(3 * scale))

    elif pose == 'standing_stressed':
        # --- STANDING STRESSED DEV (CHIBI PROPORTIONS) ---
        tremble = math.sin(t * 26) * 4 * scale

        # Knees knocking together nervously ("run chân")
        knee_jitter = math.sin(t * 24) * 6 * scale
        # Shorts
        draw.rounded_rectangle((cx - 48 * scale + tremble, cy - 10 * scale, cx + 48 * scale + tremble, cy + 45 * scale), radius=int(10 * scale), fill=PANTS, outline=INK, width=int(5 * scale))

        # Left Leg
        thigh_l_knee = (cx - 14 * scale + knee_jitter, cy + 105 * scale)
        foot_l = (cx - 30 * scale + tremble, cy + 155 * scale)
        draw_smooth_curve(draw, [(cx - 28 * scale + tremble, cy + 40 * scale), thigh_l_knee, foot_l], fill=INK, width=int(26 * scale))
        draw_smooth_curve(draw, [(cx - 28 * scale + tremble, cy + 40 * scale), thigh_l_knee, foot_l], fill=SKIN, width=int(18 * scale))

        # Right Leg
        thigh_r_knee = (cx + 14 * scale - knee_jitter, cy + 105 * scale)
        foot_r = (cx + 30 * scale + tremble, cy + 155 * scale)
        draw_smooth_curve(draw, [(cx + 28 * scale + tremble, cy + 40 * scale), thigh_r_knee, foot_r], fill=INK, width=int(26 * scale))
        draw_smooth_curve(draw, [(cx + 28 * scale + tremble, cy + 40 * scale), thigh_r_knee, foot_r], fill=SKIN, width=int(18 * scale))

        # Yellow Honeycomb Slippers
        draw.rounded_rectangle((foot_l[0] - 22 * scale, foot_l[1] - 8 * scale, foot_l[0] + 22 * scale, foot_l[1] + 16 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK, width=int(4 * scale))
        for hx in [-14, -5, 5, 14]:
            draw.point((foot_l[0] + hx * scale, foot_l[1] + 4 * scale), fill='#ca8a04')

        draw.rounded_rectangle((foot_r[0] - 22 * scale, foot_r[1] - 8 * scale, foot_r[0] + 22 * scale, foot_r[1] + 16 * scale), radius=int(6 * scale), fill=SLIPPER, outline=INK, width=int(4 * scale))
        for hx in [-14, -5, 5, 14]:
            draw.point((foot_r[0] + hx * scale, foot_r[1] + 4 * scale), fill='#ca8a04')

        # Torso
        torso_pts = [
            (cx - 48 * scale + tremble, cy - 90 * scale),
            (cx - 58 * scale + tremble, cy - 35 * scale),
            (cx - 48 * scale + tremble, cy),
            (cx + 48 * scale + tremble, cy),
            (cx + 58 * scale + tremble, cy - 35 * scale),
            (cx + 48 * scale + tremble, cy - 90 * scale),
        ]
        draw_smooth_curve(draw, torso_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=SHIRT)

        # Head
        head_cx = cx + tremble
        head_cy = cy - 150 * scale
        head_r = 52 * scale

        head_pts = [
            (head_cx - head_r, head_cy),
            (head_cx - head_r + 5 * scale, head_cy - 40 * scale),
            (head_cx, head_cy - 52 * scale),
            (head_cx + head_r - 5 * scale, head_cy - 40 * scale),
            (head_cx + head_r, head_cy),
            (head_cx + head_r - 10 * scale, head_cy + 42 * scale),
            (head_cx, head_cy + 52 * scale),
            (head_cx - head_r + 10 * scale, head_cy + 42 * scale),
        ]
        draw_smooth_curve(draw, head_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=SKIN)

        # Spiky stressed hair
        hair_pts = [
            (head_cx - head_r - 8 * scale, head_cy - 10 * scale),
            (head_cx - head_r - 4 * scale, head_cy - 50 * scale),
            (head_cx - 25 * scale, head_cy - 72 * scale),
            (head_cx, head_cy - 75 * scale),
            (head_cx + 30 * scale, head_cy - 70 * scale),
            (head_cx + head_r + 6 * scale, head_cy - 45 * scale),
            (head_cx + head_r + 4 * scale, head_cy - 10 * scale),
            (head_cx + 35 * scale, head_cy - 30 * scale),
            (head_cx + 10 * scale, head_cy - 38 * scale),
            (head_cx - 15 * scale, head_cy - 35 * scale),
            (head_cx - 38 * scale, head_cy - 28 * scale)
        ]
        draw_smooth_curve(draw, hair_pts, fill=INK, width=int(6 * scale), closed=True, fill_color='#1e293b')
        for angle in [-65, -35, -5, 25, 55]:
            rad = math.radians(angle)
            spike = 30 * scale + math.sin(t * 16 + angle) * 8 * scale
            sx = head_cx + math.sin(rad) * (head_r + spike)
            sy = head_cy - math.cos(rad) * (head_r + spike)
            draw.line([(head_cx + math.sin(rad) * head_r, head_cy - math.cos(rad) * head_r), (sx, sy)], fill=INK, width=int(5 * scale))

        # Stressed Eyebrows /\
        draw.line([(head_cx - 35 * scale, head_cy - 12 * scale), (head_cx - 10 * scale, head_cy - 24 * scale)], fill=INK, width=int(5 * scale))
        draw.line([(head_cx + 10 * scale, head_cy - 24 * scale), (head_cx + 35 * scale, head_cy - 12 * scale)], fill=INK, width=int(5 * scale))

        # Stressed Eyes: Wide open with vibrating pupils
        p_jit = math.sin(t * 30) * 2 * scale
        draw.ellipse((head_cx - 35 * scale, head_cy - 14 * scale, head_cx - 9 * scale, head_cy + 12 * scale), fill='#ffffff', outline=INK, width=int(4 * scale))
        draw.ellipse((head_cx + 9 * scale, head_cy - 14 * scale, head_cx + 35 * scale, head_cy + 12 * scale), fill='#ffffff', outline=INK, width=int(4 * scale))
        draw.ellipse((head_cx - 24 * scale + p_jit, head_cy - 3 * scale, head_cx - 18 * scale + p_jit, head_cy + 3 * scale), fill=INK)
        draw.ellipse((head_cx + 18 * scale + p_jit, head_cy - 3 * scale, head_cx + 24 * scale + p_jit, head_cy + 3 * scale), fill=INK)

        # Wobbly mouth
        mouth_pts = []
        for mx in range(-18, 19, 4):
            my = math.sin(mx * 0.35 + t * 16) * 4 * scale
            mouth_pts.append((head_cx + mx * scale, head_cy + 24 * scale + my))
        for mi in range(len(mouth_pts) - 1):
            draw.line([mouth_pts[mi], mouth_pts[mi+1]], fill=INK, width=int(4 * scale))

        # Dripping sweat drop
        sw_y = head_cy - 10 * scale + ((t * 40 * scale) % (55 * scale))
        draw.ellipse((head_cx + 45 * scale, sw_y, head_cx + 60 * scale, sw_y + 18 * scale), fill='#38bdf8', outline=INK, width=int(3 * scale))

        # Left Arm: Scratching head
        scratch_y = math.sin(t * 16) * 8 * scale
        draw_smooth_curve(draw, [
            (cx - 45 * scale + tremble, cy - 70 * scale),
            (cx - 85 * scale + tremble, cy - 120 * scale),
            (head_cx - 25 * scale, head_cy - 45 * scale + scratch_y)
        ], fill=INK, width=int(14 * scale))
        draw_smooth_curve(draw, [
            (cx - 45 * scale + tremble, cy - 70 * scale),
            (cx - 85 * scale + tremble, cy - 120 * scale),
            (head_cx - 25 * scale, head_cy - 45 * scale + scratch_y)
        ], fill=SKIN, width=int(9 * scale))
        draw.ellipse((head_cx - 36 * scale, head_cy - 55 * scale + scratch_y, head_cx - 14 * scale, head_cy - 30 * scale + scratch_y), fill=SKIN, outline=INK, width=int(3 * scale))

        # Right Arm: Holding phone trembling
        draw_smooth_curve(draw, [
            (cx + 45 * scale + tremble, cy - 70 * scale),
            (cx + 85 * scale + tremble, cy - 25 * scale),
            (cx + 100 * scale + tremble, cy - 55 * scale)
        ], fill=INK, width=int(14 * scale))
        draw_smooth_curve(draw, [
            (cx + 45 * scale + tremble, cy - 70 * scale),
            (cx + 85 * scale + tremble, cy - 25 * scale),
            (cx + 100 * scale + tremble, cy - 55 * scale)
        ], fill=SKIN, width=int(9 * scale))
        draw.rounded_rectangle((cx + 90 * scale + tremble, cy - 90 * scale, cx + 130 * scale + tremble, cy - 20 * scale), radius=int(6 * scale), fill='#0284c7', outline=INK, width=int(4 * scale))

    elif pose == 'dizzy_slumped':
        # --- EXHAUSTED / DIZZY SLUMPED DEV ---
        stool_y = cy + 110 * scale
        draw.rounded_rectangle((cx - 80 * scale, stool_y, cx + 80 * scale, stool_y + 25 * scale), radius=int(8 * scale), fill='#0284c7', outline=INK, width=int(5 * scale))
        draw.line([(cx - 65 * scale, stool_y + 25 * scale), (cx - 75 * scale, stool_y + 75 * scale)], fill=INK, width=int(6 * scale))
        draw.line([(cx + 65 * scale, stool_y + 25 * scale), (cx + 75 * scale, stool_y + 75 * scale)], fill=INK, width=int(6 * scale))

        # Legs under stool
        draw_smooth_curve(draw, [(cx - 40 * scale, stool_y + 10 * scale), (cx - 50 * scale, stool_y + 80 * scale)], fill=INK, width=int(18 * scale))
        draw_smooth_curve(draw, [(cx - 40 * scale, stool_y + 10 * scale), (cx - 50 * scale, stool_y + 80 * scale)], fill=SKIN, width=int(12 * scale))
        draw_smooth_curve(draw, [(cx + 40 * scale, stool_y + 10 * scale), (cx + 50 * scale, stool_y + 80 * scale)], fill=INK, width=int(18 * scale))
        draw_smooth_curve(draw, [(cx + 40 * scale, stool_y + 10 * scale), (cx + 50 * scale, stool_y + 80 * scale)], fill=SKIN, width=int(12 * scale))
        draw.rounded_rectangle((cx - 70 * scale, stool_y + 75 * scale, cx - 30 * scale, stool_y + 92 * scale), radius=int(5 * scale), fill=SLIPPER, outline=INK, width=int(3 * scale))
        draw.rounded_rectangle((cx + 30 * scale, stool_y + 75 * scale, cx + 70 * scale, stool_y + 92 * scale), radius=int(5 * scale), fill=SLIPPER, outline=INK, width=int(3 * scale))

        # Slumped torso
        torso_pts = [
            (cx - 30 * scale, stool_y),
            (cx - 55 * scale, stool_y - 60 * scale),
            (cx, stool_y - 75 * scale),
            (cx + 35 * scale, stool_y),
        ]
        draw_smooth_curve(draw, torso_pts, fill=INK, width=int(5 * scale), closed=True, fill_color=SHIRT)

        # Drooping head with hair
        head_cx = cx - 55 * scale
        head_cy = stool_y - 120 * scale
        head_r = 48 * scale
        draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=SKIN, outline=INK, width=int(5 * scale))

        # Floppy hair drooping
        draw.chord((head_cx - head_r - 5 * scale, head_cy - head_r - 8 * scale, head_cx + head_r + 5 * scale, head_cy - 5 * scale), start=180, end=360, fill='#1e293b')

        # Spiral dizzy eyes (@ @)
        for ex in [head_cx - 18 * scale, head_cx + 18 * scale]:
            spiral_pts = []
            for deg in range(0, 540, 30):
                rad = math.radians(deg + t * 360)
                r = (deg / 540) * 14 * scale
                spiral_pts.append((ex + math.cos(rad) * r, head_cy - 4 * scale + math.sin(rad) * r))
            for sp in range(len(spiral_pts) - 1):
                draw.line([spiral_pts[sp], spiral_pts[sp+1]], fill=INK, width=int(3 * scale))

        # Open mouth with tongue panting
        draw.arc((head_cx - 14 * scale, head_cy + 10 * scale, head_cx + 14 * scale, head_cy + 28 * scale), start=0, end=180, fill='#ef4444', width=int(4 * scale))
        draw.ellipse((head_cx - 8 * scale, head_cy + 18 * scale, head_cx + 8 * scale, head_cy + 32 * scale), fill='#f43f5e')

        # Limp dangling arms
        draw_smooth_curve(draw, [(cx - 40 * scale, stool_y - 50 * scale), (cx - 70 * scale, stool_y - 10 * scale), (cx - 65 * scale, stool_y + 40 * scale)], fill=INK, width=int(14 * scale))
        draw_smooth_curve(draw, [(cx - 40 * scale, stool_y - 50 * scale), (cx - 70 * scale, stool_y - 10 * scale), (cx - 65 * scale, stool_y + 40 * scale)], fill=SKIN, width=int(9 * scale))

        # Cute white soul ghost floating away: "x_x"
        ghost_y = head_cy - 35 * scale - ((t * 30 * scale) % (90 * scale))
        ghost_x = head_cx + math.sin(t * 3) * 15 * scale
        draw.ellipse((ghost_x - 14 * scale, ghost_y - 14 * scale, ghost_x + 14 * scale, ghost_y + 14 * scale), fill='#f1f5f9', outline=INK, width=int(2 * scale))
        draw.text((ghost_x - 8 * scale, ghost_y - 10 * scale), "x_x", fill=INK)

# Alias
draw_organic_dev = draw_charming_dev

# ==========================================
# 2. ANIMATED ROBOT (Frantic typing & steam)
# ==========================================
def draw_animated_robot(draw, cx, cy, scale=1.0, t=0.0):
    shake = math.sin(t * 32) * 3 * scale

    # Antenna
    draw.line([(cx + shake, cy - 90 * scale), (cx + shake, cy - 145 * scale)], fill=INK, width=int(6 * scale))
    light_color = '#ef4444' if (int(t * 6) % 2 == 0) else '#facc15'
    draw.ellipse((cx - 16 * scale + shake, cy - 170 * scale, cx + 16 * scale + shake, cy - 138 * scale), fill=light_color, outline=INK, width=int(4 * scale))
    for sp_ang in [30, 90, 150, 210, 270, 330]:
        s_rad = math.radians(sp_ang)
        draw.line([
            (cx + shake + math.cos(s_rad) * 20 * scale, cy - 154 * scale + math.sin(s_rad) * 20 * scale),
            (cx + shake + math.cos(s_rad) * 32 * scale, cy - 154 * scale + math.sin(s_rad) * 32 * scale)
        ], fill='#f59e0b', width=int(3 * scale))

    for s_idx, s_off in enumerate([0.0, 0.35, 0.7]):
        s_t = (t * 0.8 + s_off) % 1.0
        smk_y = cy - 100 * scale - s_t * 110 * scale
        smk_x = cx - 50 * scale + math.sin(s_t * 6) * 25 * scale + shake
        smk_r = (14 + s_t * 22) * scale
        draw.ellipse((smk_x - smk_r, smk_y - smk_r, smk_x + smk_r, smk_y + smk_r), fill='#f8fafc', outline='#94a3b8', width=int(3 * scale))

    head_pts = [
        (cx - 75 * scale + shake, cy - 90 * scale),
        (cx - 85 * scale + shake, cy - 25 * scale),
        (cx + 85 * scale + shake, cy - 25 * scale),
        (cx + 75 * scale + shake, cy - 90 * scale),
    ]
    draw_smooth_curve(draw, head_pts, fill=INK, width=int(6 * scale), closed=True, fill_color='#94a3b8')

    draw_smooth_curve(draw, [
        (cx - 60 * scale + shake, cy - 80 * scale),
        (cx - 65 * scale + shake, cy - 35 * scale),
        (cx + 65 * scale + shake, cy - 35 * scale),
        (cx + 60 * scale + shake, cy - 80 * scale),
    ], fill=INK, width=int(4 * scale), closed=True, fill_color='#0f172a')

    eye_flash = math.sin(t * 16) * 2 * scale
    draw.ellipse((cx - 45 * scale + shake, cy - 65 * scale + eye_flash, cx - 18 * scale + shake, cy - 45 * scale + eye_flash), fill='#38bdf8')
    draw.ellipse((cx + 18 * scale + shake, cy - 65 * scale - eye_flash, cx + 45 * scale + shake, cy - 45 * scale - eye_flash), fill='#38bdf8')

    body_pts = [
        (cx - 70 * scale + shake, cy - 15 * scale),
        (cx - 80 * scale + shake, cy + 90 * scale),
        (cx + 80 * scale + shake, cy + 90 * scale),
        (cx + 70 * scale + shake, cy - 15 * scale),
    ]
    draw_smooth_curve(draw, body_pts, fill=INK, width=int(6 * scale), closed=True, fill_color='#cbd5e1')

    draw.rounded_rectangle((cx - 50 * scale + shake, cy + 10 * scale, cx + 50 * scale + shake, cy + 65 * scale), radius=int(8 * scale), fill='#0284c7', outline=INK, width=int(3 * scale))
    draw.text((cx - 38 * scale + shake, cy + 22 * scale), "126K", fill='#ffffff', font=FONT_BOLD)

    arm_l_y = math.sin(t * 24) * 25 * scale
    arm_r_y = -math.sin(t * 24) * 25 * scale

    draw_smooth_curve(draw, [
        (cx - 70 * scale + shake, cy + 15 * scale),
        (cx - 120 * scale + shake, cy + 50 * scale + arm_l_y * 0.5),
        (cx - 80 * scale + shake, cy + 120 * scale + arm_l_y)
    ], fill=INK, width=int(12 * scale))
    claw_l = (cx - 80 * scale + shake, cy + 120 * scale + arm_l_y)
    draw.arc((claw_l[0] - 15 * scale, claw_l[1] - 15 * scale, claw_l[0] + 15 * scale, claw_l[1] + 15 * scale), start=60, end=240, fill=INK, width=int(5 * scale))

    draw_smooth_curve(draw, [
        (cx + 70 * scale + shake, cy + 15 * scale),
        (cx + 120 * scale + shake, cy + 50 * scale + arm_r_y * 0.5),
        (cx + 80 * scale + shake, cy + 120 * scale + arm_r_y)
    ], fill=INK, width=int(12 * scale))
    claw_r = (cx + 80 * scale + shake, cy + 120 * scale + arm_r_y)
    draw.arc((claw_r[0] - 15 * scale, claw_r[1] - 15 * scale, claw_r[0] + 15 * scale, claw_r[1] + 15 * scale), start=300, end=120, fill=INK, width=int(5 * scale))

    draw.rounded_rectangle((cx - 110 * scale, cy + 115 * scale, cx + 110 * scale, cy + 155 * scale), radius=int(6 * scale), fill='#334155', outline=INK, width=int(5 * scale))
    for lx in range(-80, 81, 25):
        key_jitter = math.sin(t * 30 + lx) * 8 * scale
        draw.line([(cx + lx * scale, cy + 112 * scale), (cx + lx * scale, cy + 98 * scale + key_jitter)], fill='#f59e0b', width=int(3 * scale))

# ==========================================
# 3. ORGANIC TOKEN FIRE
# ==========================================
def draw_token_fire(draw, cx, cy, scale=1.0, t=0.0):
    flame_outer = []
    flame_inner = []
    num_pts = 12
    for i in range(num_pts):
        ang = (i / num_pts) * math.pi * 2
        flicker_o = math.sin(t * 14 + i * 1.5) * 15 * scale
        flicker_i = math.cos(t * 18 + i * 2.0) * 10 * scale
        rx_o = (60 * scale + flicker_o) if math.sin(ang) < 0 else (45 * scale)
        ry_o = (90 * scale + flicker_o) if math.sin(ang) < 0 else (40 * scale)
        flame_outer.append((cx + math.cos(ang) * rx_o, cy + math.sin(ang) * ry_o))
        rx_i = (35 * scale + flicker_i) if math.sin(ang) < 0 else (25 * scale)
        ry_i = (55 * scale + flicker_i) if math.sin(ang) < 0 else (22 * scale)
        flame_inner.append((cx + math.cos(ang) * rx_i, cy + math.sin(ang) * ry_i + 15 * scale))

    draw_smooth_curve(draw, flame_outer, fill='#dc2626', width=int(4 * scale), closed=True, fill_color='#ea580c')
    draw_smooth_curve(draw, flame_inner, fill='#f59e0b', width=int(3 * scale), closed=True, fill_color='#fde047')

    for p_idx, p_off in enumerate([0.1, 0.45, 0.8]):
        p_t = (t * 0.9 + p_off) % 1.0
        p_y = cy - p_t * 140 * scale
        p_x = cx - 40 * scale + math.sin((t + p_off) * 5) * 35 * scale + (p_idx - 1) * 30 * scale
        p_w = 40 * scale * (1.0 - p_t * 0.4)
        p_h = 24 * scale * (1.0 - p_t * 0.4)
        draw.rounded_rectangle((p_x, p_y, p_x + p_w, p_y + p_h), radius=int(4 * scale), fill='#fef08a', outline=INK, width=int(2 * scale))
        draw.text((p_x + 6 * scale, p_y + 2 * scale), "$", fill='#ea580c', font=FONT_SM)

# ==========================================
# 4. ORGANIC TRÀ ĐÁ TABLE
# ==========================================
def draw_tra_da_table(draw, cx, cy, scale=1.0, t=0.0):
    crate_top = [
        (cx - 150 * scale, cy + 40 * scale),
        (cx - 140 * scale, cy + 25 * scale),
        (cx, cy + 20 * scale),
        (cx + 140 * scale, cy + 25 * scale),
        (cx + 150 * scale, cy + 40 * scale),
        (cx + 135 * scale, cy + 65 * scale),
        (cx, cy + 70 * scale),
        (cx - 135 * scale, cy + 65 * scale),
    ]
    draw_smooth_curve(draw, crate_top, fill=INK, width=int(5 * scale), closed=True, fill_color='#b45309')
    draw_smooth_curve(draw, [(cx - 120 * scale, cy + 65 * scale), (cx - 135 * scale, cy + 180 * scale)], fill=INK, width=int(6 * scale))
    draw_smooth_curve(draw, [(cx - 45 * scale, cy + 68 * scale), (cx - 50 * scale, cy + 175 * scale)], fill=INK, width=int(5 * scale))
    draw_smooth_curve(draw, [(cx + 45 * scale, cy + 68 * scale), (cx + 50 * scale, cy + 175 * scale)], fill=INK, width=int(5 * scale))
    draw_smooth_curve(draw, [(cx + 120 * scale, cy + 65 * scale), (cx + 135 * scale, cy + 180 * scale)], fill=INK, width=int(6 * scale))

    # Glass of Iced Tea
    tea_x = cx - 45 * scale
    tea_y = cy - 70 * scale
    glass_pts = [
        (tea_x - 30 * scale, tea_y),
        (tea_x + 30 * scale, tea_y),
        (tea_x + 22 * scale, tea_y + 95 * scale),
        (tea_x - 22 * scale, tea_y + 95 * scale),
    ]
    draw_smooth_curve(draw, glass_pts, fill=INK, width=int(4 * scale), closed=True, fill_color='#ffffff')
    liquid_pts = [
        (tea_x - 27 * scale, tea_y + 25 * scale),
        (tea_x + 27 * scale, tea_y + 25 * scale),
        (tea_x + 20 * scale, tea_y + 92 * scale),
        (tea_x - 20 * scale, tea_y + 92 * scale),
    ]
    draw_smooth_curve(draw, liquid_pts, fill='#d97706', width=int(2 * scale), closed=True, fill_color='#f59e0b')

    ice_bob = math.sin(t * 3.5) * 3 * scale
    draw.rounded_rectangle((tea_x - 18 * scale, tea_y + 35 * scale + ice_bob, tea_x - 2 * scale, tea_y + 52 * scale + ice_bob), radius=int(3 * scale), fill='#fef08a', outline=INK, width=int(2 * scale))
    draw.rounded_rectangle((tea_x + 2 * scale, tea_y + 45 * scale - ice_bob, tea_x + 18 * scale, tea_y + 62 * scale - ice_bob), radius=int(3 * scale), fill='#fef08a', outline=INK, width=int(2 * scale))

    lemon_x = tea_x - 25 * scale
    lemon_y = tea_y + 6 * scale
    draw.ellipse((lemon_x - 14 * scale, lemon_y - 14 * scale, lemon_x + 14 * scale, lemon_y + 14 * scale), fill='#fde047', outline=INK, width=int(3 * scale))

    straw_pts = [
        (tea_x + 10 * scale, tea_y + 80 * scale),
        (tea_x + 22 * scale, tea_y - 10 * scale),
        (tea_x + 36 * scale, tea_y - 35 * scale)
    ]
    draw_smooth_curve(draw, straw_pts, fill='#ef4444', width=int(6 * scale))

    for v_i, v_off in enumerate([0.0, 0.5]):
        v_t = (t * 0.7 + v_off) % 1.0
        v_y = tea_y - 15 * scale - v_t * 60 * scale
        v_x = tea_x + math.sin(v_t * 5 + v_i) * 12 * scale
        draw.arc((v_x - 8 * scale, v_y - 8 * scale, v_x + 8 * scale, v_y + 8 * scale), start=180, end=360, fill='#94a3b8', width=int(2 * scale))

    plate_x = cx + 60 * scale
    plate_y = cy + 30 * scale
    plate_pts = [
        (plate_x - 45 * scale, plate_y),
        (plate_x, plate_y - 12 * scale),
        (plate_x + 45 * scale, plate_y),
        (plate_x, plate_y + 14 * scale)
    ]
    draw_smooth_curve(draw, plate_pts, fill=INK, width=int(4 * scale), closed=True, fill_color='#e2e8f0')
    seeds = [(-20, -2), (-8, -6), (6, -4), (18, 0), (-12, 4), (4, 5), (14, 3)]
    for sx, sy in seeds:
        draw.ellipse((plate_x + sx * scale - 4 * scale, plate_y + sy * scale - 2 * scale, plate_x + sx * scale + 4 * scale, plate_y + sy * scale + 2 * scale), fill='#1e293b')

# ==========================================
# 5. MULTI-DEVICE ECOSYSTEM (PC, Laptop, VPS)
# ==========================================
def draw_multi_device_ecosystem(draw, cx, cy, scale=1.0, t=0.0):
    hub_cx, hub_cy = cx, cy + 30 * scale

    # Left: CRT PC
    pc_cx, pc_cy = cx - 270 * scale, cy - 110 * scale
    # Top: Cloud VPS
    cloud_cx, cloud_cy = cx, cy - 210 * scale + math.sin(t * 3) * 8 * scale
    # Right: Laptop
    lap_cx, lap_cy = cx + 270 * scale, cy - 110 * scale

    # Undulating cables (drawn first so they connect neatly behind devices and hub)
    for dev_x, dev_y in [(pc_cx + 45 * scale, pc_cy + 55 * scale), (cloud_cx, cloud_cy + 50 * scale), (lap_cx - 45 * scale, lap_cy + 50 * scale)]:
        pts = []
        for s in range(16):
            ratio = s / 15.0
            x = dev_x + ratio * (hub_cx - dev_x)
            y = dev_y + ratio * (hub_cy - dev_y) + math.sin(ratio * math.pi + t * 4) * 16 * scale
            pts.append((x, y))
        for pi in range(len(pts) - 1):
            draw.line([pts[pi], pts[pi+1]], fill='#64748b', width=int(6 * scale))
        pulse_idx = int(((t * 1.5) % 1.0) * (len(pts) - 1))
        px, py = pts[pulse_idx]
        draw.ellipse((px - 9 * scale, py - 9 * scale, px + 9 * scale, py + 9 * scale), fill='#38bdf8')

    # Central Hub
    draw.rounded_rectangle((hub_cx - 150 * scale, hub_cy - 45 * scale, hub_cx + 150 * scale, hub_cy + 45 * scale), radius=int(16 * scale), fill='#0066FF', outline=INK, width=int(5 * scale))
    draw.text((hub_cx - 120 * scale, hub_cy - 18 * scale), "REMOTE-CLI HUB", fill='#ffffff', font=FONT_BOLD)

    # Left: CRT PC Details
    zap_active = (int(t * 6) % 3 == 0)
    if zap_active:
        for z_ang in [45, 135, 225, 315]:
            rad = math.radians(z_ang)
            draw.line([
                (pc_cx + math.cos(rad) * 80 * scale, pc_cy + math.sin(rad) * 65 * scale),
                (pc_cx + math.cos(rad) * 110 * scale, pc_cy + math.sin(rad) * 95 * scale)
            ], fill='#eab308', width=int(5 * scale))

    draw.rounded_rectangle((pc_cx - 95 * scale, pc_cy - 70 * scale, pc_cx + 95 * scale, pc_cy + 70 * scale), radius=int(16 * scale), fill='#e2e8f0', outline=INK, width=int(6 * scale))
    draw.rounded_rectangle((pc_cx - 80 * scale, pc_cy - 55 * scale, pc_cx + 80 * scale, pc_cy + 55 * scale), radius=int(10 * scale), fill='#0f172a', outline=INK, width=int(4 * scale))
    draw.text((pc_cx - 65 * scale, pc_cy - 25 * scale), "> remote-cli", fill='#22c55e', font=FONT_SM)
    draw.text((pc_cx - 65 * scale, pc_cy + 10 * scale), "[START OK]", fill='#22c55e', font=FONT_SM)
    draw.line([(pc_cx - 50 * scale, pc_cy + 90 * scale), (pc_cx + 50 * scale, pc_cy + 90 * scale)], fill=INK, width=int(7 * scale))

    # Top: Cloud VPS Details
    for ox, oy, r in [(-55, 0, 48), (0, -25, 58), (55, 0, 48), (-25, 20, 42), (25, 20, 42)]:
        draw.ellipse((cloud_cx + ox * scale - r * scale, cloud_cy + oy * scale - r * scale, cloud_cx + ox * scale + r * scale, cloud_cy + oy * scale + r * scale), fill='#e0f2fe', outline=INK, width=int(4 * scale))
    draw.text((cloud_cx - 55 * scale, cloud_cy - 16 * scale), "CLOUD VPS", fill='#0369a1', font=FONT_BOLD)

    for b_idx, (bx_off, by_base) in enumerate([(-45, 48), (-12, 52), (18, 46), (48, 54)]):
        b_y = cloud_cy + by_base * scale + ((t * 40 * scale + b_idx * 25) % (70 * scale))
        draw.text((cloud_cx + bx_off * scale, b_y), "1" if b_idx % 2 == 0 else "0", fill='#0284c7', font=FONT_SM)

    # Right: Laptop Details
    draw.rounded_rectangle((lap_cx - 90 * scale, lap_cy - 65 * scale, lap_cx + 90 * scale, lap_cy + 40 * scale), radius=int(12 * scale), fill='#475569', outline=INK, width=int(6 * scale))
    draw.rounded_rectangle((lap_cx - 75 * scale, lap_cy - 52 * scale, lap_cx + 75 * scale, lap_cy + 28 * scale), radius=int(8 * scale), fill='#0284c7', outline=INK, width=int(4 * scale))
    draw.text((lap_cx - 52 * scale, lap_cy - 18 * scale), "LAPTOP", fill='#ffffff', font=FONT_BOLD)
    draw.polygon([(lap_cx - 105 * scale, lap_cy + 40 * scale), (lap_cx + 105 * scale, lap_cy + 40 * scale), (lap_cx + 120 * scale, lap_cy + 75 * scale), (lap_cx - 120 * scale, lap_cy + 75 * scale)], fill='#94a3b8')
    draw.line([(lap_cx - 120 * scale, lap_cy + 75 * scale), (lap_cx + 120 * scale, lap_cy + 75 * scale)], fill=INK, width=int(6 * scale))

    # 1-Tab Browser Bar Switcher at bottom
    tab_y = cy + 170 * scale
    draw.rounded_rectangle((cx - 360 * scale, tab_y, cx + 360 * scale, tab_y + 110 * scale), radius=int(16 * scale), fill='#ffffff', outline=INK, width=int(5 * scale))

    cur_tab = int((t * 1.2) % 3)
    tab_labels = ["1. PC Cũ", "2. Laptop", "3. Cloud VPS"]
    for t_i, t_label in enumerate(tab_labels):
        tx0 = cx - 340 * scale + t_i * 230 * scale
        tx1 = tx0 + 215 * scale
        t_fill = '#0066FF' if t_i == cur_tab else '#f1f5f9'
        t_text_color = '#ffffff' if t_i == cur_tab else '#475569'
        draw.rounded_rectangle((tx0, tab_y + 15 * scale, tx1, tab_y + 85 * scale), radius=int(10 * scale), fill=t_fill, outline=INK, width=int(3 * scale))
        draw.text((tx0 + 25 * scale, tab_y + 35 * scale), t_label, fill=t_text_color, font=FONT_BOLD)

# ==========================================
# 6. ACTIVE PENCIL TEST-TAKING (Scene 6)
# ==========================================
def draw_active_pencil_test(draw, cx, cy, scale=1.0, t=0.0):
    pw, ph = 380 * scale, 340 * scale
    draw.rounded_rectangle((cx - pw, cy - ph, cx + pw, cy + ph), radius=int(22 * scale), fill='#ffffff', outline=INK, width=int(6 * scale))

    draw.rounded_rectangle((cx - 330 * scale, cy - 310 * scale, cx + 330 * scale, cy - 240 * scale), radius=int(12 * scale), fill='#f8fafc', outline=INK, width=int(3 * scale))
    draw.text((cx - 280 * scale, cy - 290 * scale), "PHIẾU ĐÁNH GIÁ CHUẨN HITL", fill=INK, font=FONT_TITLE)

    questions = [
        ("1. Cho phép chạy lệnh bash?", cy - 190 * scale),
        ("2. Sửa code file config.ts?", cy - 90 * scale),
        ("3. Chạy lệnh git push main?", cy + 10 * scale),
        ("4. Xóa session cũ giải phóng RAM?", cy + 110 * scale),
    ]

    active_q_idx = int(t / 0.6)

    for q_i, (q_text, q_y) in enumerate(questions):
        draw.text((cx - 320 * scale, q_y), q_text, fill=INK, font=FONT_BOLD)

        circle_a = (cx - 280 * scale, q_y + 45 * scale)
        draw.arc((circle_a[0] - 16 * scale, circle_a[1] - 16 * scale, circle_a[0] + 16 * scale, circle_a[1] + 16 * scale), start=0, end=360, fill=INK, width=int(3 * scale))
        draw.text((circle_a[0] + 30 * scale, circle_a[1] - 14 * scale), "(A) Đồng ý [Recommend]", fill='#0284c7', font=FONT_REGULAR)

        circle_b = (cx + 90 * scale, q_y + 45 * scale)
        draw.arc((circle_b[0] - 16 * scale, circle_b[1] - 16 * scale, circle_b[0] + 16 * scale, circle_b[1] + 16 * scale), start=0, end=360, fill=INK, width=int(3 * scale))
        draw.text((circle_b[0] + 30 * scale, circle_b[1] - 14 * scale), "(B) Từ chối", fill='#64748b', font=FONT_REGULAR)

        if q_i < active_q_idx:
            draw.ellipse((circle_a[0] - 13 * scale, circle_a[1] - 13 * scale, circle_a[0] + 13 * scale, circle_a[1] + 13 * scale), fill=INK)
            draw.line([(circle_a[0] - 25 * scale, circle_a[1]), (circle_a[0] - 8 * scale, circle_a[1] + 16 * scale), (circle_a[0] + 20 * scale, circle_a[1] - 16 * scale)], fill='#ef4444', width=int(6 * scale))
        elif q_i == active_q_idx:
            scribble_phase = (t % 0.6) / 0.6
            for deg in range(0, int(scribble_phase * 720), 40):
                rad = math.radians(deg)
                sr = (deg / 720) * 13 * scale
                draw.point((circle_a[0] + math.cos(rad) * sr, circle_a[1] + math.sin(rad) * sr), fill=INK)

            pencil_tip_x = circle_a[0] + math.sin(t * 30) * 4 * scale
            pencil_tip_y = circle_a[1] + math.cos(t * 30) * 4 * scale
            draw.line([(pencil_tip_x, pencil_tip_y), (pencil_tip_x + 60 * scale, pencil_tip_y - 120 * scale)], fill='#eab308', width=int(12 * scale))
            draw.line([(pencil_tip_x, pencil_tip_y), (pencil_tip_x + 14 * scale, pencil_tip_y - 28 * scale)], fill=INK, width=int(12 * scale))
            draw.ellipse((pencil_tip_x + 25 * scale, pencil_tip_y - 65 * scale, pencil_tip_x + 65 * scale, pencil_tip_y - 25 * scale), fill=SKIN, outline=INK, width=int(4 * scale))

# ==========================================
# 7. ANIME FLURRY BARRAGE (Scene 5)
# ==========================================
def draw_spam_recommend_barrage(draw, cx, cy, scale=1.0, t=0.0):
    impact_beat = (t * 12) % 1.0
    squash = math.sin(impact_beat * math.pi) * 10 * scale

    btn_w, btn_h = 360 * scale + squash * 2, 80 * scale - squash
    draw.rounded_rectangle((cx - btn_w, cy - btn_h, cx + btn_w, cy + btn_h), radius=int(22 * scale), fill='#0066FF', outline='#ffffff', width=int(6 * scale))
    draw.text((cx - 200 * scale, cy - 24 * scale), "[ BẤM RECOMMEND ]", fill='#ffffff', font=FONT_HERO)

    for arm_i in range(5):
        phase = (t * 14 + arm_i * 0.2) % 1.0
        arm_y = cy - 160 * scale + phase * 150 * scale
        arm_x = cx + (arm_i - 2.0) * 85 * scale
        draw.line([(arm_x - 50 * scale, arm_y - 120 * scale), (arm_x, arm_y)], fill=SKIN, width=int(26 * scale))
        draw.ellipse((arm_x - 26 * scale, arm_y - 20 * scale, arm_x + 26 * scale, arm_y + 20 * scale), fill=SKIN, outline=INK, width=int(4 * scale))

    for sp_ang in [0, 45, 90, 135, 180, 225, 270, 315]:
        rad = math.radians(sp_ang)
        draw.line([
            (cx + math.cos(rad) * 110 * scale, cy + math.sin(rad) * 45 * scale),
            (cx + math.cos(rad) * 150 * scale, cy + math.sin(rad) * 65 * scale)
        ], fill='#facc15', width=int(5 * scale))

# ==========================================
# 8. OVERLOADED MIND (Scene 5 - Context Fragmentation)
# ==========================================
def draw_overloaded_mind(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders the dev's head smoking with panic, surrounded by
    swirling project questions and context overload.
    """
    shake = math.sin(t * 28) * 4 * scale

    head_cx = cx + shake
    head_cy = cy
    head_r = 65 * scale

    # Steam shooting from ears
    for ear_dir in [-1, 1]:
        ear_x = head_cx + ear_dir * (head_r + 10 * scale)
        for s_i, s_off in enumerate([0.0, 0.4]):
            s_t = (t * 1.5 + s_off) % 1.0
            smk_x = ear_x + ear_dir * (20 + s_t * 60) * scale
            smk_y = head_cy - 10 * scale - s_t * 30 * scale
            draw.ellipse((smk_x - 12 * scale, smk_y - 12 * scale, smk_x + 12 * scale, smk_y + 12 * scale), fill='#f1f5f9', outline='#94a3b8', width=int(3 * scale))

    # Ears
    draw.ellipse((head_cx - head_r - 8 * scale, head_cy - 10 * scale, head_cx - head_r + 14 * scale, head_cy + 18 * scale), fill=SKIN, outline=INK, width=int(4 * scale))
    draw.ellipse((head_cx + head_r - 14 * scale, head_cy - 10 * scale, head_cx + head_r + 8 * scale, head_cy + 18 * scale), fill=SKIN, outline=INK, width=int(4 * scale))

    # Head bean
    draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=SKIN, outline=INK, width=int(5 * scale))

    # Frazzled Messy Hair
    hair_pts = [
        (head_cx - head_r - 10 * scale, head_cy - 20 * scale),
        (head_cx - head_r - 5 * scale, head_cy - 65 * scale),
        (head_cx - 30 * scale, head_cy - 90 * scale),
        (head_cx, head_cy - 95 * scale),
        (head_cx + 35 * scale, head_cy - 90 * scale),
        (head_cx + head_r + 8 * scale, head_cy - 60 * scale),
        (head_cx + head_r + 6 * scale, head_cy - 15 * scale),
        (head_cx + 40 * scale, head_cy - 40 * scale),
        (head_cx + 12 * scale, head_cy - 48 * scale),
        (head_cx - 18 * scale, head_cy - 45 * scale),
        (head_cx - 45 * scale, head_cy - 38 * scale)
    ]
    draw_smooth_curve(draw, hair_pts, fill=INK, width=int(7 * scale), closed=True, fill_color='#1e293b')

    # Spikes of stress
    for angle in [-70, -45, -20, 0, 20, 45, 70]:
        rad = math.radians(angle)
        sp_len = 25 * scale + math.sin(t * 20 + angle) * 10 * scale
        draw.line([
            (head_cx + math.sin(rad) * head_r, head_cy - math.cos(rad) * head_r),
            (head_cx + math.sin(rad) * (head_r + sp_len), head_cy - math.cos(rad) * (head_r + sp_len))
        ], fill=INK, width=int(5 * scale))

    # Spiral Eyes (@ @)
    for ex in [head_cx - 24 * scale, head_cx + 24 * scale]:
        spiral_pts = []
        for deg in range(0, 540, 30):
            rad = math.radians(deg + t * 360)
            r = (deg / 540) * 16 * scale
            spiral_pts.append((ex + math.cos(rad) * r, head_cy - 6 * scale + math.sin(rad) * r))
        for sp in range(len(spiral_pts) - 1):
            draw.line([spiral_pts[sp], spiral_pts[sp+1]], fill=INK, width=int(3 * scale))

    # Open screaming / panting mouth
    draw.arc((head_cx - 20 * scale, head_cy + 15 * scale, head_cx + 20 * scale, head_cy + 42 * scale), start=0, end=180, fill='#ef4444', width=int(5 * scale))

    # Floating Project Notifications Swirling Around
    projects = [
        ("Project 1: Lỗi syntax!", -260, -180, '#ef4444', '#fee2e2'),
        ("Project 2: 47 files!", 150, -170, '#f59e0b', '#fef3c7'),
        ("Project 3: Memory 95%!", -290, 80, '#8b5cf6', '#ede9fe'),
        ("Project 4: Git conflict!", 160, 90, '#06b6d4', '#cffafe'),
    ]

    for p_label, px_base, py_base, border_c, bg_c in projects:
        bob_y = math.sin(t * 4 + px_base) * 8 * scale
        px = cx + px_base * scale
        py = cy + py_base * scale + bob_y
        draw.rounded_rectangle((px - 10 * scale, py - 6 * scale, px + 220 * scale, py + 48 * scale), radius=int(10 * scale), fill=bg_c, outline=border_c, width=int(3 * scale))
        draw.text((px + 10 * scale, py + 8 * scale), p_label, fill='#0f172a', font=FONT_SM)

def draw_chibi_overloaded_dev(draw, cx, cy, scale=1.0, t=0.0):
    """
    Renders an expressive chibi doodle dev head with rotating spiral eyes,
    steam puffs shooting from ears, sweat beads, and stress spikes.
    """
    shake = math.sin(t * 28) * 3 * scale
    head_cx = cx + shake
    head_cy = cy
    head_r = 55 * scale

    # Steam shooting from ears
    for ear_dir in [-1, 1]:
        ear_x = head_cx + ear_dir * (head_r + 6 * scale)
        for s_i, s_off in enumerate([0.0, 0.5]):
            s_t = (t * 1.6 + s_off) % 1.0
            smk_x = ear_x + ear_dir * (15 + s_t * 50) * scale
            smk_y = head_cy - 12 * scale - s_t * 25 * scale
            draw.ellipse((smk_x - 10 * scale, smk_y - 10 * scale, smk_x + 10 * scale, smk_y + 10 * scale), fill='#f1f5f9', outline='#94a3b8', width=int(2 * scale))

    # Ears
    draw.ellipse((head_cx - head_r - 6 * scale, head_cy - 8 * scale, head_cx - head_r + 12 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(3 * scale))
    draw.ellipse((head_cx + head_r - 12 * scale, head_cy - 8 * scale, head_cx + head_r + 6 * scale, head_cy + 16 * scale), fill=SKIN, outline=INK, width=int(3 * scale))

    # Head bean
    draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=SKIN, outline=INK, width=int(4 * scale))

    # Frazzled Messy Hair
    hair_pts = [
        (head_cx - head_r - 8 * scale, head_cy - 15 * scale),
        (head_cx - head_r - 4 * scale, head_cy - 55 * scale),
        (head_cx - 25 * scale, head_cy - 75 * scale),
        (head_cx, head_cy - 80 * scale),
        (head_cx + 28 * scale, head_cy - 75 * scale),
        (head_cx + head_r + 6 * scale, head_cy - 50 * scale),
        (head_cx + head_r + 4 * scale, head_cy - 10 * scale),
        (head_cx + 32 * scale, head_cy - 35 * scale),
        (head_cx + 10 * scale, head_cy - 40 * scale),
        (head_cx - 15 * scale, head_cy - 38 * scale),
        (head_cx - 36 * scale, head_cy - 32 * scale)
    ]
    draw_smooth_curve(draw, hair_pts, fill=INK, width=int(5 * scale), closed=True, fill_color='#1e293b')

    # Stress spikes
    for angle in [-60, -35, -10, 15, 40, 65]:
        rad = math.radians(angle)
        sp_len = 22 * scale + math.sin(t * 22 + angle) * 8 * scale
        draw.line([
            (head_cx + math.sin(rad) * head_r, head_cy - math.cos(rad) * head_r),
            (head_cx + math.sin(rad) * (head_r + sp_len), head_cy - math.cos(rad) * (head_r + sp_len))
        ], fill=INK, width=int(4 * scale))

    # Spiral Eyes (@ @)
    for ex in [head_cx - 20 * scale, head_cx + 20 * scale]:
        spiral_pts = []
        for deg in range(0, 540, 35):
            rad = math.radians(deg + t * 360)
            r = (deg / 540) * 14 * scale
            spiral_pts.append((ex + math.cos(rad) * r, head_cy - 5 * scale + math.sin(rad) * r))
        for sp in range(len(spiral_pts) - 1):
            draw.line([spiral_pts[sp], spiral_pts[sp+1]], fill=INK, width=int(3 * scale))

    # Screaming wobbly mouth
    draw.arc((head_cx - 16 * scale, head_cy + 12 * scale, head_cx + 16 * scale, head_cy + 36 * scale), start=0, end=180, fill='#ef4444', width=int(4 * scale))

    # Sweat beads flying
    sw_y = head_cy - 20 * scale + ((t * 45 * scale) % (45 * scale))
    draw.ellipse((head_cx + 42 * scale, sw_y, head_cx + 54 * scale, sw_y + 14 * scale), fill='#38bdf8', outline=INK, width=int(2 * scale))


