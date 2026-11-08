import math
import random
from PIL import Image, ImageDraw, ImageFont

def get_wobble(t, amp=3.0, freq=1.0):
    return math.sin(t * freq) * amp

def sketch_line(draw, p1, p2, fill='#1e293b', width=4, seed=0, overshoot=8, passes=1):
    """Draws a hand-drawn line with subtle curves, organic wobble and corner overshoots."""
    x1, y1 = p1
    x2, y2 = p2
    dx = x2 - x1
    dy = y2 - y1
    dist = math.hypot(dx, dy)
    if dist < 1:
        return

    ux = dx / dist
    uy = dy / dist
    # Perpendicular unit vector
    px = -uy
    py = ux

    rng = random.Random(seed + int(x1 * 13 + y1 * 7 + x2 * 19 + y2 * 31))

    for p in range(passes):
        p_offset = (p - (passes - 1) / 2) * 1.5
        # Overshoot endpoints
        start_x = x1 - ux * (overshoot * rng.uniform(0.6, 1.2))
        start_y = y1 - uy * (overshoot * rng.uniform(0.6, 1.2))
        end_x = x2 + ux * (overshoot * rng.uniform(0.6, 1.2))
        end_y = y2 + uy * (overshoot * rng.uniform(0.6, 1.2))

        num_segments = max(3, int(dist / 25))
        points = [(start_x, start_y)]
        for i in range(1, num_segments):
            frac = i / num_segments
            # Base pos
            bx = start_x + (end_x - start_x) * frac
            by = start_y + (end_y - start_y) * frac
            # Wobble perpendicular
            wobble = rng.uniform(-2.5, 2.5) * math.sin(frac * math.pi)
            points.append((bx + px * (wobble + p_offset), by + py * (wobble + p_offset)))
        points.append((end_x, end_y))

        for j in range(len(points) - 1):
            draw.line([points[j], points[j+1]], fill=fill, width=width)

def sketch_rect(draw, box, fill_color=None, outline='#1e293b', width=4, seed=0, overshoot=10):
    """Draws an organic sketch rectangle with 4 overshooting hand-drawn lines."""
    x1, y1, x2, y2 = box
    if fill_color:
        draw.rectangle((x1, y1, x2, y2), fill=fill_color)
    sketch_line(draw, (x1, y1), (x2, y1), fill=outline, width=width, seed=seed+1, overshoot=overshoot)
    sketch_line(draw, (x2, y1), (x2, y2), fill=outline, width=width, seed=seed+2, overshoot=overshoot)
    sketch_line(draw, (x2, y2), (x1, y2), fill=outline, width=width, seed=seed+3, overshoot=overshoot)
    sketch_line(draw, (x1, y2), (x1, y1), fill=outline, width=width, seed=seed+4, overshoot=overshoot)

def sketch_circle(draw, center, radius, fill_color=None, outline='#1e293b', width=4, seed=0):
    """Draws a hand-drawn circle with an organic overlapping tail (375-390 degrees)."""
    cx, cy = center
    rng = random.Random(seed + int(cx * 11 + cy * 17 + radius))
    if fill_color:
        draw.ellipse((cx - radius, cy - radius, cx + radius, cy + radius), fill=fill_color)

    num_pts = 36
    max_deg = 360 + rng.randint(15, 30) # overlaps end
    pts = []
    for i in range(num_pts + 1):
        angle = math.radians(i / num_pts * max_deg)
        r = radius + rng.uniform(-2.2, 2.2)
        px = cx + r * math.cos(angle)
        py = cy + r * math.sin(angle)
        pts.append((px, py))

    for j in range(len(pts) - 1):
        draw.line([pts[j], pts[j+1]], fill=outline, width=width)

def sketch_bezier(draw, p0, p1, p2, fill='#1e293b', width=5, seed=0, num_steps=20):
    """Draws a smooth organic hand-drawn Bézier curve for bending limbs/arms."""
    rng = random.Random(seed)
    pts = []
    for i in range(num_steps + 1):
        t = i / num_steps
        # Quadratic Bézier: (1-t)^2 * p0 + 2(1-t)t * p1 + t^2 * p2
        bx = (1 - t)**2 * p0[0] + 2 * (1 - t) * t * p1[0] + t**2 * p2[0]
        by = (1 - t)**2 * p0[1] + 2 * (1 - t) * t * p1[1] + t**2 * p2[1]
        wobble = rng.uniform(-1.5, 1.5) if (0 < i < num_steps) else 0
        pts.append((bx + wobble, by + wobble))

    for j in range(len(pts) - 1):
        draw.line([pts[j], pts[j+1]], fill=fill, width=width)
