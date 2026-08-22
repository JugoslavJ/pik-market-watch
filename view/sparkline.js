// OLX.ba Price per m² — View: Price per m² — inline SVG sparkline renderer

class Sparkline {
  static render(values, { width = 56, height = 22, colour = '#002f34' } = {}) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width',  width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.style.display = 'block';

    const valid = values.filter(v => v != null);
    if (valid.length === 0) return svg;

    const pad  = 2;
    const minV = Math.min(...valid);
    const maxV = Math.max(...valid);
    const rangeV = maxV - minV || 1;

    const toX = i => pad + (i  / Math.max(valid.length - 1, 1)) * (width  - pad * 2);
    const toY = v => pad + (1 - (v - minV) / rangeV)            * (height - pad * 2);

    if (valid.length === 1) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', width / 2);
      circle.setAttribute('cy', height / 2);
      circle.setAttribute('r',  2.5);
      circle.setAttribute('fill', colour);
      svg.appendChild(circle);
      return svg;
    }

    const points   = valid.map((v, i) => `${toX(i)},${toY(v)}`).join(' ');
    const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points',          points);
    polyline.setAttribute('fill',            'none');
    polyline.setAttribute('stroke',          colour);
    polyline.setAttribute('stroke-width',    '1.5');
    polyline.setAttribute('stroke-linejoin', 'round');
    polyline.setAttribute('stroke-linecap',  'round');
    svg.appendChild(polyline);

    const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dot.setAttribute('cx',   toX(valid.length - 1));
    dot.setAttribute('cy',   toY(valid[valid.length - 1]));
    dot.setAttribute('r',    2.5);
    dot.setAttribute('fill', colour);
    svg.appendChild(dot);

    return svg;
  }
}
