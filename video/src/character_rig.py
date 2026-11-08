import math
from PIL import Image, ImageDraw, ImageFont

def draw_curved_tube(draw, p0, p1, p2, width=8, fill='#1e293b', num_steps=16):
    """Draws a smooth bending limb using Bézier curve with round caps."""
    pts = []
    for i in range(num_steps + 1):
        t = i / num_steps
        x = (1 - t)**2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        y = (1 - t)**2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        pts.append((x, y))

    for i in range(len(pts) - 1):
        draw.line([pts[i], pts[i+1]], fill=fill, width=width)
    for p in pts:
        r = width // 2
        draw.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=fill)

def draw_dev_character(draw, center_x, ground_y, scale=1.0, pose='sitting', t=0.0):
    """
    Renders an expressive, animated doodle dev character.
    pose: 'sitting' (tra da), 'standing_stressed', 'panicking_tapping', 'exhausted'
    """
    # Animation parameters
    blink = (int(t * 3) % 8 == 0) and ((t * 3) % 1.0 < 0.25)
    mouth_open = (int(t * 8) % 2 == 0) # lip-sync chatter
    breathing = math.sin(t * 3.5) * 4 * scale

    ink = '#1e293b'
    skin = '#ffedd5'
    shirt_color = '#38bdf8'
    pants_color = '#475569'
    flipflop_color = '#facc15'

    if pose == 'sitting':
        # Sitting on stool at Tra Da
        # Base hips
        hip_x = center_x
        hip_y = ground_y - 210 * scale + breathing

        # Torso (curved bean shape)
        chest_x = hip_x - 10 * scale
        chest_y = hip_y - 120 * scale

        # Draw Stool under dev
        stool_top_y = hip_y + 15 * scale
        # Curved plastic stool seat
        draw.rounded_rectangle(
            (center_x - 90 * scale, stool_top_y, center_x + 90 * scale, stool_top_y + 35 * scale),
            radius=int(10 * scale), fill='#0284c7', outline=ink, width=int(5 * scale)
        )
        # Stool legs splayed
        draw.line([(center_x - 70 * scale, stool_top_y + 35 * scale), (center_x - 95 * scale, ground_y)], fill=ink, width=int(6 * scale))
        draw.line([(center_x - 30 * scale, stool_top_y + 35 * scale), (center_x - 45 * scale, ground_y - 10 * scale)], fill=ink, width=int(5 * scale))
        draw.line([(center_x + 30 * scale, stool_top_y + 35 * scale), (center_x + 45 * scale, ground_y - 10 * scale)], fill=ink, width=int(5 * scale))
        draw.line([(center_x + 70 * scale, stool_top_y + 35 * scale), (center_x + 95 * scale, ground_y)], fill=ink, width=int(6 * scale))
        # Stool ring
        draw.line([(center_x - 85 * scale, ground_y - 60 * scale), (center_x + 85 * scale, ground_y - 60 * scale)], fill='#0284c7', width=int(5 * scale))

        # Legs
        # Left leg (resting relaxed)
        knee_l_x = hip_x - 65 * scale
        knee_l_y = hip_y + 85 * scale
        foot_l_x = knee_l_x - 10 * scale
        foot_l_y = ground_y - 15 * scale
        draw_curved_tube(draw, (hip_x - 20 * scale, hip_y), (knee_l_x, knee_l_y), (foot_l_x, foot_l_y), width=int(14 * scale), fill=pants_color)
        draw_curved_tube(draw, (knee_l_x, knee_l_y), (knee_l_x - 5 * scale, foot_l_y - 10 * scale), (foot_l_x, foot_l_y), width=int(11 * scale), fill=skin)
        # Left slipper
        draw.rounded_rectangle((foot_l_x - 30 * scale, foot_l_y - 8 * scale, foot_l_x + 25 * scale, foot_l_y + 16 * scale), radius=int(6 * scale), fill=flipflop_color, outline=ink, width=int(4 * scale))

        # Right leg (rhythmically tapping foot: "nhịp giò")
        foot_bounce = math.sin(t * 14) * 16 * scale
        knee_r_x = hip_x + 55 * scale
        knee_r_y = hip_y + 80 * scale + foot_bounce * 0.4
        foot_r_x = knee_r_x + 20 * scale
        foot_r_y = ground_y - 15 * scale + foot_bounce
        draw_curved_tube(draw, (hip_x + 20 * scale, hip_y), (knee_r_x, knee_r_y), (foot_r_x, foot_r_y), width=int(14 * scale), fill=pants_color)
        draw_curved_tube(draw, (knee_r_x, knee_r_y), (knee_r_x + 10 * scale, foot_r_y - 10 * scale), (foot_r_x, foot_r_y), width=int(11 * scale), fill=skin)
        # Right slipper (angled when tapping)
        draw.rounded_rectangle((foot_r_x - 25 * scale, foot_r_y - 8 * scale, foot_r_x + 30 * scale, foot_r_y + 16 * scale), radius=int(6 * scale), fill=flipflop_color, outline=ink, width=int(4 * scale))
        if foot_bounce < -4 * scale:
            # Tap sound dust ring
            draw.arc((foot_r_x - 15 * scale, ground_y - 10 * scale, foot_r_x + 35 * scale, ground_y + 10 * scale), start=0, end=180, fill='#94a3b8', width=int(3 * scale))

        # Torso: soft rounded organic t-shirt
        torso_pts = [
            (chest_x - 50 * scale, chest_y),
            (chest_x + 50 * scale, chest_y),
            (hip_x + 45 * scale, hip_y),
            (hip_x - 45 * scale, hip_y)
        ]
        draw.polygon(torso_pts, fill=shirt_color)
        draw.line(torso_pts + [torso_pts[0]], fill=ink, width=int(5 * scale))

        # Head & Neck
        head_cx = chest_x + 5 * scale
        head_cy = chest_y - 75 * scale + breathing * 0.5
        head_r = 55 * scale

        # Curved ear
        draw.ellipse((head_cx - head_r - 8 * scale, head_cy - 8 * scale, head_cx - head_r + 14 * scale, head_cy + 16 * scale), fill=skin, outline=ink, width=int(4 * scale))
        draw.ellipse((head_cx + head_r - 14 * scale, head_cy - 8 * scale, head_cx + head_r + 8 * scale, head_cy + 16 * scale), fill=skin, outline=ink, width=int(4 * scale))

        # Head Circle
        draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=skin, outline=ink, width=int(5 * scale))

        # Floppy wavy dev hair
        hair_color = '#1e293b'
        # Multiple overlapping curved hair tufts
        draw.chord((head_cx - head_r - 5 * scale, head_cy - head_r - 10 * scale, head_cx + head_r + 5 * scale, head_cy - 10 * scale), start=180, end=360, fill=hair_color)
        for hx, hy, r in [(-30, -45, 22), (-10, -55, 24), (15, -52, 25), (35, -42, 20), (5, -62, 18)]:
            draw.ellipse((head_cx + hx * scale - r * scale, head_cy + hy * scale - r * scale, head_cx + hx * scale + r * scale, head_cy + hy * scale + r * scale), fill=hair_color)

        # Facial Expression (Relaxed, smiling dev)
        # Eyebrows (gentle curve)
        draw.arc((head_cx - 38 * scale, head_cy - 28 * scale, head_cx - 8 * scale, head_cy - 12 * scale), start=200, end=340, fill=ink, width=int(4 * scale))
        draw.arc((head_cx + 8 * scale, head_cy - 28 * scale, head_cx + 38 * scale, head_cy - 12 * scale), start=200, end=340, fill=ink, width=int(4 * scale))

        # Eyes (Blinking animation)
        if blink:
            draw.line([(head_cx - 32 * scale, head_cy - 8 * scale), (head_cx - 14 * scale, head_cy - 8 * scale)], fill=ink, width=int(4 * scale))
            draw.line([(head_cx + 14 * scale, head_cy - 8 * scale), (head_cx + 32 * scale, head_cy - 8 * scale)], fill=ink, width=int(4 * scale))
        else:
            # Happy smiling eyes (curved arcs or big cute anime doodle eyes)
            draw.arc((head_cx - 34 * scale, head_cy - 16 * scale, head_cx - 12 * scale, head_cy + 2 * scale), start=0, end=180, fill=ink, width=int(5 * scale))
            draw.arc((head_cx + 12 * scale, head_cy - 16 * scale, head_cx + 34 * scale, head_cy + 2 * scale), start=0, end=180, fill=ink, width=int(5 * scale))

        # Cute nose
        draw.arc((head_cx - 6 * scale, head_cy - 2 * scale, head_cx + 6 * scale, head_cy + 10 * scale), start=270, end=90, fill=ink, width=int(3 * scale))

        # Warm Smile
        draw.arc((head_cx - 20 * scale, head_cy + 8 * scale, head_cx + 20 * scale, head_cy + 30 * scale), start=10, end=170, fill='#ef4444', width=int(5 * scale))

        # Cheerful blush circles on cheeks
        draw.ellipse((head_cx - 42 * scale, head_cy + 2 * scale, head_cx - 24 * scale, head_cy + 16 * scale), fill='#fecdd3')
        draw.ellipse((head_cx + 24 * scale, head_cy + 2 * scale, head_cx + 42 * scale, head_cy + 16 * scale), fill='#fecdd3')

        # Arms holding smartphone in front
        phone_cx = chest_x
        phone_cy = chest_y + 45 * scale
        # Left arm: Shoulder -> Elbow -> Hands
        draw_curved_tube(draw, (chest_x - 45 * scale, chest_y + 15 * scale), (chest_x - 55 * scale, chest_y + 65 * scale), (phone_cx - 25 * scale, phone_cy + 10 * scale), width=int(12 * scale), fill=skin)
        # Right arm: Shoulder -> Elbow -> Hands
        draw_curved_tube(draw, (chest_x + 45 * scale, chest_y + 15 * scale), (chest_x + 55 * scale, chest_y + 65 * scale), (phone_cx + 25 * scale, phone_cy + 10 * scale), width=int(12 * scale), fill=skin)

        # Smartphone in hands
        phone_w, phone_h = 55 * scale, 85 * scale
        draw.rounded_rectangle((phone_cx - phone_w/2, phone_cy - phone_h/2, phone_cx + phone_w/2, phone_cy + phone_h/2), radius=int(8 * scale), fill='#0284c7', outline=ink, width=int(4 * scale))
        # Screen glow
        draw.rounded_rectangle((phone_cx - phone_w/2 + 5 * scale, phone_cy - phone_h/2 + 6 * scale, phone_cx + phone_w/2 - 5 * scale, phone_cy + phone_h/2 - 6 * scale), radius=int(5 * scale), fill='#e0f2fe')

        # Thumbs actively tapping on screen!
        tap_l = math.sin(t * 18) * 5 * scale
        tap_r = math.cos(t * 18) * 5 * scale
        # Left thumb
        draw.ellipse((phone_cx - 22 * scale, phone_cy - 10 * scale + tap_l, phone_cx - 6 * scale, phone_cy + 8 * scale + tap_l), fill=skin, outline=ink, width=int(3 * scale))
        # Right thumb
        draw.ellipse((phone_cx + 6 * scale, phone_cy - 10 * scale + tap_r, phone_cx + 22 * scale, phone_cy + 8 * scale + tap_r), fill=skin, outline=ink, width=int(3 * scale))

        # Floating chat heart / message bubbles floating up from phone!
        float_y = (t * 60 * scale) % (120 * scale)
        heart_x = phone_cx + math.sin(t * 4) * 20 * scale
        heart_y = phone_cy - 45 * scale - float_y
        heart_alpha = max(0.0, min(1.0, 1.0 - (float_y / (120 * scale))))
        if heart_alpha > 0.1:
            draw.text((heart_x - 12 * scale, heart_y), "💬", fill='#0284c7')

    elif pose == 'standing_stressed':
        # Dev standing, scratching head in panic / confusion
        hip_x = center_x
        hip_y = ground_y - 280 * scale + breathing

        # Standing legs
        draw_curved_tube(draw, (hip_x - 25 * scale, hip_y), (hip_x - 35 * scale, ground_y - 140 * scale), (hip_x - 30 * scale, ground_y - 15 * scale), width=int(16 * scale), fill=pants_color)
        draw_curved_tube(draw, (hip_x + 25 * scale, hip_y), (hip_x + 35 * scale, ground_y - 140 * scale), (hip_x + 30 * scale, ground_y - 15 * scale), width=int(16 * scale), fill=pants_color)
        # Feet
        draw.rounded_rectangle((hip_x - 60 * scale, ground_y - 15 * scale, hip_x, ground_y + 10 * scale), radius=int(6 * scale), fill=flipflop_color, outline=ink, width=int(4 * scale))
        draw.rounded_rectangle((hip_x, ground_y - 15 * scale, hip_x + 60 * scale, ground_y + 10 * scale), radius=int(6 * scale), fill=flipflop_color, outline=ink, width=int(4 * scale))

        # Torso
        chest_x = hip_x
        chest_y = hip_y - 150 * scale
        draw.rounded_rectangle((chest_x - 55 * scale, chest_y, chest_x + 55 * scale, hip_y), radius=int(14 * scale), fill=shirt_color, outline=ink, width=int(5 * scale))

        # Head
        head_cx = chest_x
        head_cy = chest_y - 85 * scale
        head_r = 60 * scale
        draw.ellipse((head_cx - head_r, head_cy - head_r, head_cx + head_r, head_cy + head_r), fill=skin, outline=ink, width=int(5 * scale))

        # Messy hair standing on end (frazzled)
        draw.chord((head_cx - head_r - 5 * scale, head_cy - head_r - 10 * scale, head_cx + head_r + 5 * scale, head_cy - 10 * scale), start=180, end=360, fill='#1e293b')
        # Wild spikes
        for angle in [-60, -30, 0, 30, 60]:
            rad = math.radians(angle)
            spike_len = 35 * scale + math.sin(t * 10 + angle) * 8 * scale
            sx = head_cx + math.sin(rad) * (head_r + spike_len)
            sy = head_cy - math.cos(rad) * (head_r + spike_len)
            draw.line([(head_cx + math.sin(rad) * head_r, head_cy - math.cos(rad) * head_r), (sx, sy)], fill=ink, width=int(6 * scale))

        # Stressed face: Wobbly mouth, sweat drop
        # Worried eyebrows angled upward /\
        draw.line([(head_cx - 40 * scale, head_cy - 18 * scale), (head_cx - 15 * scale, head_cy - 30 * scale)], fill=ink, width=int(5 * scale))
        draw.line([(head_cx + 15 * scale, head_cy - 30 * scale), (head_cx + 40 * scale, head_cy - 18 * scale)], fill=ink, width=int(5 * scale))

        # Stressed eyes: Open wide with tiny pupils vibrating
        eye_jitter = math.sin(t * 30) * 3 * scale
        draw.ellipse((head_cx - 38 * scale, head_cy - 18 * scale, head_cx - 12 * scale, head_cy + 8 * scale), fill='#ffffff', outline=ink, width=int(4 * scale))
        draw.ellipse((head_cx + 12 * scale, head_cy - 18 * scale, head_cx + 38 * scale, head_cy + 8 * scale), fill='#ffffff', outline=ink, width=int(4 * scale))
        draw.ellipse((head_cx - 27 * scale + eye_jitter, head_cy - 7 * scale, head_cx - 21 * scale + eye_jitter, head_cy - 1 * scale), fill=ink)
        draw.ellipse((head_cx + 21 * scale + eye_jitter, head_cy - 7 * scale, head_cx + 27 * scale + eye_jitter, head_cy - 1 * scale), fill=ink)

        # Wobbly squiggly mouth (~ shape)
        mouth_pts = []
        for mx in range(-25, 26, 5):
            my = math.sin(mx * 0.25 + t * 12) * 5 * scale
            mouth_pts.append((head_cx + mx * scale, head_cy + 22 * scale + my))
        for mi in range(len(mouth_pts) - 1):
            draw.line([mouth_pts[mi], mouth_pts[mi+1]], fill=ink, width=int(5 * scale))

        # Giant dripping sweat drop
        sweat_y = head_cy - 10 * scale + ((t * 40 * scale) % (60 * scale))
        draw.ellipse((head_cx + 50 * scale, sweat_y, head_cx + 66 * scale, sweat_y + 22 * scale), fill='#38bdf8', outline=ink, width=int(3 * scale))

        # Left arm: Scratching back of head! (Curved elbow high)
        scratch_y = math.sin(t * 16) * 8 * scale
        draw_curved_tube(draw, (chest_x - 50 * scale, chest_y + 20 * scale), (chest_x - 90 * scale, chest_y - 40 * scale), (head_cx - 30 * scale, head_cy - 50 * scale + scratch_y), width=int(14 * scale), fill=skin)
        # Hand on head
        draw.ellipse((head_cx - 40 * scale, head_cy - 60 * scale + scratch_y, head_cx - 15 * scale, head_cy - 35 * scale + scratch_y), fill=skin, outline=ink, width=int(3 * scale))

        # Right arm: Holding phone out looking baffled
        draw_curved_tube(draw, (chest_x + 50 * scale, chest_y + 20 * scale), (chest_x + 95 * scale, chest_y + 60 * scale), (chest_x + 110 * scale, chest_y + 20 * scale), width=int(14 * scale), fill=skin)
        # Phone
        draw.rounded_rectangle((chest_x + 100 * scale, chest_y - 20 * scale, chest_x + 140 * scale, chest_y + 50 * scale), radius=int(6 * scale), fill='#0284c7', outline=ink, width=int(4 * scale))
