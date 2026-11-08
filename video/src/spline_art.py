import math
from PIL import Image, ImageDraw

def catmull_rom_spline(points, num_points_per_seg=15, closed=False):
    """
    Computes a smooth Catmull-Rom spline through a list of (x, y) control points.
    Creates 100% smooth, organic, fluid curves - no straight ruler lines!
    """
    if len(points) < 3:
        return points

    pts = list(points)
    if closed:
        pts = [pts[-1]] + pts + [pts[0], pts[1]]
    else:
        # duplicate endpoints for clamp
        pts = [pts[0]] + pts + [pts[-1]]

    curve = []
    for i in range(1, len(pts) - 2):
        p0, p1, p2, p3 = pts[i-1], pts[i], pts[i+1], pts[i+2]
        for step in range(num_points_per_seg):
            t = step / num_points_per_seg
            t2 = t * t
            t3 = t2 * t
            x = 0.5 * ((2 * p1[0]) +
                       (-p0[0] + p2[0]) * t +
                       (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
                       (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3)
            y = 0.5 * ((2 * p1[1]) +
                       (-p0[1] + p2[1]) * t +
                       (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
                       (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3)
            curve.append((x, y))
    if not closed:
        curve.append(points[-1])
    return curve

def draw_smooth_curve(draw, points, fill='#1e293b', width=6, closed=False, fill_color=None):
    spline = catmull_rom_spline(points, num_points_per_seg=16, closed=closed)
    if closed and fill_color:
        draw.polygon(spline, fill=fill_color)
    for i in range(len(spline) - 1):
        draw.line([spline[i], spline[i+1]], fill=fill, width=width)
    if closed and len(spline) > 1:
        draw.line([spline[-1], spline[0]], fill=fill, width=width)
    for p in spline:
        r = width // 2
        draw.ellipse((p[0] - r, p[1] - r, p[0] + r, p[1] + r), fill=fill)
