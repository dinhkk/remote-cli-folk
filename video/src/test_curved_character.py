import math
from PIL import Image, ImageDraw
from spline_art import catmull_rom_spline, draw_smooth_curve

def draw_organic_dev(draw, cx, cy, scale=1.0, t=0.0):
    """Draws a truly organic, hand-drawn sketch dev character with fluid curves."""
    ink = '#1e293b'
    skin = '#ffedd5'
    shirt = '#38bdf8'
    pants = '#334155'
    slipper = '#facc15'

    # Breathing & swaying
    sway = math.sin(t * 3.0) * 4 * scale
    breathe = math.cos(t * 3.0) * 5 * scale

    # 1. Hips and Sitting Stool
    stool_y = cy + 180 * scale
    # Stool top: soft rounded curve
    stool_pts = [
        (cx - 110 * scale, stool_y),
        (cx - 100 * scale, stool_y - 15 * scale),
        (cx, stool_y - 20 * scale),
        (cx + 100 * scale, stool_y - 15 * scale),
        (cx + 110 * scale, stool_y),
        (cx + 90 * scale, stool_y + 35 * scale),
        (cx, stool_y + 40 * scale),
        (cx - 90 * scale, stool_y + 35 * scale),
    ]
    draw_smooth_curve(draw, stool_pts, fill=ink, width=int(6 * scale), closed=True, fill_color='#0284c7')
    # Splayed wobbly legs of stool
    draw.line([(cx - 75 * scale, stool_y + 35 * scale), (cx - 105 * scale, stool_y + 190 * scale)], fill=ink, width=int(7 * scale))
    draw.line([(cx - 30 * scale, stool_y + 35 * scale), (cx - 45 * scale, stool_y + 180 * scale)], fill=ink, width=int(6 * scale))
    draw.line([(cx + 30 * scale, stool_y + 35 * scale), (cx + 45 * scale, stool_y + 180 * scale)], fill=ink, width=int(6 * scale))
    draw.line([(cx + 75 * scale, stool_y + 35 * scale), (cx + 105 * scale, stool_y + 190 * scale)], fill=ink, width=int(7 * scale))

    # 2. Pants & Shorts (Soft curved folds)
    shorts_pts = [
        (cx - 65 * scale, cy + 110 * scale + breathe),
        (cx - 75 * scale, cy + 175 * scale),
        (cx - 20 * scale, cy + 190 * scale),
        (cx, cy + 165 * scale),
        (cx + 20 * scale, cy + 190 * scale),
        (cx + 75 * scale, cy + 175 * scale),
        (cx + 65 * scale, cy + 110 * scale + breathe),
        (cx, cy + 120 * scale + breathe)
    ]
    draw_smooth_curve(draw, shorts_pts, fill=ink, width=int(6 * scale), closed=True, fill_color=pants)

    # 3. Legs
    # Left Leg (resting relaxed with curved calf)
    leg_l_pts = [
        (cx - 50 * scale, cy + 185 * scale),
        (cx - 75 * scale, cy + 260 * scale),
        (cx - 60 * scale, cy + 340 * scale),
        (cx - 70 * scale, cy + 365 * scale)
    ]
    draw_smooth_curve(draw, leg_l_pts, fill=ink, width=int(14 * scale))
    draw_smooth_curve(draw, [(p[0], p[1]) for p in leg_l_pts], fill=skin, width=int(10 * scale))
    # Slipper
    slipper_l = [
        (cx - 110 * scale, cy + 360 * scale),
        (cx - 60 * scale, cy + 355 * scale),
        (cx - 35 * scale, cy + 375 * scale),
        (cx - 70 * scale, cy + 385 * scale),
        (cx - 110 * scale, cy + 375 * scale)
    ]
    draw_smooth_curve(draw, slipper_l, fill=ink, width=int(5 * scale), closed=True, fill_color=slipper)

    # Right Leg (Tapping foot excitedly!)
    tap_bounce = math.sin(t * 14) * 20 * scale
    leg_r_pts = [
        (cx + 50 * scale, cy + 185 * scale),
        (cx + 75 * scale, cy + 250 * scale + tap_bounce * 0.4),
        (cx + 65 * scale, cy + 330 * scale + tap_bounce * 0.8),
        (cx + 75 * scale, cy + 355 * scale + tap_bounce)
    ]
    draw_smooth_curve(draw, leg_r_pts, fill=ink, width=int(14 * scale))
    draw_smooth_curve(draw, [(p[0], p[1]) for p in leg_r_pts], fill=skin, width=int(10 * scale))
    # Slipper right
    foot_y = cy + 355 * scale + tap_bounce
    slipper_r = [
        (cx + 40 * scale, foot_y - 5 * scale),
        (cx + 95 * scale, foot_y - 12 * scale),
        (cx + 120 * scale, foot_y + 12 * scale),
        (cx + 80 * scale, foot_y + 24 * scale),
        (cx + 40 * scale, foot_y + 12 * scale)
    ]
    draw_smooth_curve(draw, slipper_r, fill=ink, width=int(5 * scale), closed=True, fill_color=slipper)

    # Tap dust / action ripples
    if tap_bounce < -5 * scale:
        draw.arc((cx + 50 * scale, cy + 365 * scale, cx + 130 * scale, cy + 395 * scale), start=0, end=180, fill='#94a3b8', width=int(4 * scale))
        draw.arc((cx + 40 * scale, cy + 355 * scale, cx + 140 * scale, cy + 405 * scale), start=0, end=180, fill='#cbd5e1', width=int(3 * scale))

    # 4. Pear-shaped Curved Torso (Oversized comfortable t-shirt)
    torso_pts = [
        (cx - 45 * scale + sway, cy - 10 * scale + breathe),   # Left shoulder
        (cx - 70 * scale + sway, cy + 40 * scale + breathe),   # Left chest curve
        (cx - 60 * scale + sway, cy + 120 * scale + breathe),  # Left hip
        (cx, cy + 130 * scale + breathe),                      # Belly bottom
        (cx + 60 * scale + sway, cy + 120 * scale + breathe),  # Right hip
        (cx + 70 * scale + sway, cy + 40 * scale + breathe),   # Right chest curve
        (cx + 45 * scale + sway, cy - 10 * scale + breathe),   # Right shoulder
        (cx, cy - 18 * scale + breathe)                        # Collar
    ]
    draw_smooth_curve(draw, torso_pts, fill=ink, width=int(6 * scale), closed=True, fill_color=shirt)
    # Wrinkle curves on shirt
    draw_smooth_curve(draw, [(cx - 30 * scale + sway, cy + 50 * scale), (cx + sway, cy + 65 * scale), (cx + 35 * scale + sway, cy + 55 * scale)], fill='#0284c7', width=int(4 * scale))
    draw_smooth_curve(draw, [(cx - 20 * scale + sway, cy + 90 * scale), (cx + 15 * scale + sway, cy + 95 * scale)], fill='#0284c7', width=int(4 * scale))

    # 5. Head (Large cute cartoon bean head)
    head_cx = cx + sway * 0.7
    head_cy = cy - 85 * scale + breathe * 0.7
    # Head outline (slightly tilted with ear bumps)
    head_pts = [
        (head_cx - 55 * scale, head_cy),
        (head_cx - 60 * scale, head_cy - 45 * scale),
        (head_cx - 30 * scale, head_cy - 75 * scale),
        (head_cx, head_cy - 80 * scale),
        (head_cx + 35 * scale, head_cy - 75 * scale),
        (head_cx + 60 * scale, head_cy - 45 * scale),
        (head_cx + 55 * scale, head_cy),
        (head_cx + 45 * scale, head_cy + 45 * scale),
        (head_cx, head_cy + 55 * scale),
        (head_cx - 45 * scale, head_cy + 45 * scale)
    ]
    draw_smooth_curve(draw, head_pts, fill=ink, width=int(6 * scale), closed=True, fill_color=skin)

    # Floppy voluminous wavy hair
    hair_pts = [
        (head_cx - 65 * scale, head_cy - 20 * scale),
        (head_cx - 70 * scale, head_cy - 65 * scale),
        (head_cx - 40 * scale, head_cy - 95 * scale),
        (head_cx, head_cy - 105 * scale),
        (head_cx + 45 * scale, head_cy - 95 * scale),
        (head_cx + 70 * scale, head_cy - 65 * scale),
        (head_cx + 65 * scale, head_cy - 20 * scale),
        (head_cx + 45 * scale, head_cy - 45 * scale),
        (head_cx + 15 * scale, head_cy - 55 * scale),
        (head_cx - 15 * scale, head_cy - 50 * scale),
        (head_cx - 45 * scale, head_cy - 45 * scale)
    ]
    draw_smooth_curve(draw, hair_pts, fill=ink, width=int(7 * scale), closed=True, fill_color='#1e293b')
    # Extra organic hair curls
    draw_smooth_curve(draw, [(head_cx - 20 * scale, head_cy - 95 * scale), (head_cx - 10 * scale, head_cy - 118 * scale), (head_cx + 5 * scale, head_cy - 100 * scale)], fill=ink, width=int(6 * scale))
    draw_smooth_curve(draw, [(head_cx + 20 * scale, head_cy - 92 * scale), (head_cx + 35 * scale, head_cy - 112 * scale), (head_cx + 45 * scale, head_cy - 90 * scale)], fill=ink, width=int(6 * scale))

    # Cute Expressive Face
    # Curved relaxed closed eyes (laughing/smiling gently)
    # Left eye: double curved arc with cute eyelashes
    draw_smooth_curve(draw, [(head_cx - 38 * scale, head_cy - 5 * scale), (head_cx - 25 * scale, head_cy + 10 * scale), (head_cx - 12 * scale, head_cy - 5 * scale)], fill=ink, width=int(5 * scale))
    # Right eye
    draw_smooth_curve(draw, [(head_cx + 12 * scale, head_cy - 5 * scale), (head_cx + 25 * scale, head_cy + 10 * scale), (head_cx + 38 * scale, head_cy - 5 * scale)], fill=ink, width=int(5 * scale))

    # Blushing pink cheeks
    draw.ellipse((head_cx - 48 * scale, head_cy + 6 * scale, head_cx - 26 * scale, head_cy + 22 * scale), fill='#fecdd3')
    draw.ellipse((head_cx + 26 * scale, head_cy + 6 * scale, head_cx + 48 * scale, head_cy + 22 * scale), fill='#fecdd3')

    # Curved smiling mouth
    draw_smooth_curve(draw, [(head_cx - 20 * scale, head_cy + 22 * scale), (head_cx, head_cy + 38 * scale), (head_cx + 20 * scale, head_cy + 22 * scale)], fill='#ef4444', width=int(5 * scale))

    # 6. Curved Arms holding Smartphone
    phone_cx = cx + sway
    phone_cy = cy + 45 * scale + breathe
    # Left Arm
    arm_l_pts = [
        (cx - 45 * scale + sway, cy + breathe),
        (cx - 80 * scale + sway, cy + 45 * scale + breathe),
        (cx - 50 * scale + sway, cy + 90 * scale + breathe),
        (phone_cx - 20 * scale, phone_cy + 20 * scale)
    ]
    draw_smooth_curve(draw, arm_l_pts, fill=ink, width=int(14 * scale))
    draw_smooth_curve(draw, arm_l_pts, fill=skin, width=int(10 * scale))

    # Right Arm
    arm_r_pts = [
        (cx + 45 * scale + sway, cy + breathe),
        (cx + 80 * scale + sway, cy + 45 * scale + breathe),
        (cx + 50 * scale + sway, cy + 90 * scale + breathe),
        (phone_cx + 20 * scale, phone_cy + 20 * scale)
    ]
    draw_smooth_curve(draw, arm_r_pts, fill=ink, width=int(14 * scale))
    draw_smooth_curve(draw, arm_r_pts, fill=skin, width=int(10 * scale))

    # Curved Smartphone
    phone_box = [
        (phone_cx - 25 * scale, phone_cy - 40 * scale),
        (phone_cx + 25 * scale, phone_cy - 40 * scale),
        (phone_cx + 28 * scale, phone_cy + 40 * scale),
        (phone_cx - 28 * scale, phone_cy + 40 * scale),
    ]
    draw_smooth_curve(draw, phone_box, fill=ink, width=int(5 * scale), closed=True, fill_color='#0284c7')
    # Glowing screen
    draw_smooth_curve(draw, [
        (phone_cx - 20 * scale, phone_cy - 33 * scale),
        (phone_cx + 20 * scale, phone_cy - 33 * scale),
        (phone_cx + 22 * scale, phone_cy + 33 * scale),
        (phone_cx - 22 * scale, phone_cy + 33 * scale),
    ], fill='#38bdf8', width=int(3 * scale), closed=True, fill_color='#e0f2fe')

    # Thumbs actively tapping on screen with tap shockwaves!
    thumb_l = math.sin(t * 18) * 6 * scale
    thumb_r = math.cos(t * 18) * 6 * scale
    draw.ellipse((phone_cx - 22 * scale, phone_cy - 5 * scale + thumb_l, phone_cx - 6 * scale, phone_cy + 12 * scale + thumb_l), fill=skin, outline=ink, width=int(3 * scale))
    draw.ellipse((phone_cx + 6 * scale, phone_cy - 5 * scale + thumb_r, phone_cx + 22 * scale, phone_cy + 12 * scale + thumb_r), fill=skin, outline=ink, width=int(3 * scale))

    # Floating chat hearts and text bubbles
    for i, offset_t in enumerate([0.0, 0.4, 0.8]):
        cycle_t = (t * 0.8 + offset_t) % 1.0
        float_y = cycle_t * 130 * scale
        float_x = math.sin((t + offset_t) * 4) * 25 * scale
        alpha = 1.0 - cycle_t
        if alpha > 0.1:
            icon_y = phone_cy - 45 * scale - float_y
            icon_x = phone_cx + float_x + (i - 1) * 30 * scale
            # Draw cute small heart or chat bubble
            draw.arc((icon_x - 12 * scale, icon_y - 12 * scale, icon_x + 12 * scale, icon_y + 12 * scale), start=0, end=360, fill='#38bdf8', width=int(3 * scale))
            draw.polygon([(icon_x - 5 * scale, icon_y + 10 * scale), (icon_x - 12 * scale, icon_y + 18 * scale), (icon_x + 2 * scale, icon_y + 12 * scale)], fill='#38bdf8')

def test():
    im = Image.new('RGB', (1080, 1080), (252, 252, 250))
    d = ImageDraw.Draw(im)
    draw_organic_dev(d, 540, 480, scale=1.4, t=1.2)
    im.save('video/test_organic_dev.png')
    print("Saved video/test_organic_dev.png")

if __name__ == '__main__':
    test()
