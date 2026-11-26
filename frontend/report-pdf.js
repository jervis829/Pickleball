/* ============================================================
   匹克球教学管理平台 V3.0 · 学员报告文档生成引擎（零依赖）
   支持：
     1. 技术类别能力报告（7大类雷达图 + 快照进步对比 + 34模块掌握明细）
     2. 6 维零道具体能测评报告（六边形图 + 常模解读 + 安全跳过 + 课堂/居家处方）
   输出格式：
     - 标准 PDF 1.4 二进制文件（A4 高清排版，直接下载转发学员）
     - 独立单文件分享版 HTML（自带矢量雷达图，手机微信打开即看）
   ============================================================ */
(function (root) {
  'use strict';

  const A4_PT_W = 595.28;
  const A4_PT_H = 841.89;
  const PAGE_PX_W = 1488;   // 180 DPI A4
  const PAGE_PX_H = 2105;
  const FONT_SANS = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC","Hiragino Sans GB","Helvetica Neue",Arial,sans-serif';
  const FONT_MONO = '"IBM Plex Mono","SFMono-Regular",Menlo,Consolas,monospace';

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));

  /* ==================== 1. 零依赖 PDF 1.4 封装器 ==================== */
  function dataUrlToBytes(dataUrl) {
    const idx = String(dataUrl || '').indexOf(',');
    if (idx < 0) throw new Error('无效的图像 DataURL');
    const b64 = dataUrl.slice(idx + 1);
    let bin;
    if (typeof atob === 'function') {
      bin = atob(b64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }

  function asciiBytes(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
    return out;
  }

  function concatUint8(chunks) {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    return out;
  }

  /**
   * 将多张 A4 JPEG 页面打包为标准 PDF 1.4 二进制字节流
   * @param {Array<{bytes?:Uint8Array, dataUrl?:string, widthPx:number, heightPx:number}>} pages
   * @returns {Uint8Array}
   */
  function buildPdfFromJpegPages(pages) {
    if (!Array.isArray(pages) || !pages.length) {
      throw new Error('PDF 至少需要 1 页内容');
    }
    const chunks = [];
    const offsets = [0]; // 1-based object offsets; 0 is free object
    let cursor = 0;
    const pushRaw = (u8) => { chunks.push(u8); cursor += u8.length; };
    const pushStr = (s) => pushRaw(asciiBytes(s));

    // PDF Header + binary marker
    pushRaw(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    // Reserve object IDs: 1 = Catalog, 2 = Pages, then 3 objects per page
    const pageObjIds = pages.map((_, i) => 3 + i * 3);

    const writeObj = (objId, bodyParts) => {
      offsets[objId] = cursor;
      pushStr(`${objId} 0 obj\n`);
      for (const p of bodyParts) {
        if (typeof p === 'string') pushStr(p);
        else pushRaw(p);
      }
      pushStr('\nendobj\n');
    };

    writeObj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
    writeObj(2, [`<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`]);

    pages.forEach((pg, i) => {
      const jpg = pg.bytes || dataUrlToBytes(pg.dataUrl);
      const w = Math.max(1, Math.round(pg.widthPx || PAGE_PX_W));
      const h = Math.max(1, Math.round(pg.heightPx || PAGE_PX_H));
      const pageId = 3 + i * 3;
      const imgId = pageId + 1;
      const contentId = pageId + 2;
      const contentCmd = `q\n${A4_PT_W.toFixed(2)} 0 0 ${A4_PT_H.toFixed(2)} 0 0 cm\n/Im${i} Do\nQ\n`;

      writeObj(pageId, [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_PT_W.toFixed(2)} ${A4_PT_H.toFixed(2)}] ` +
        `/Resources << /XObject << /Im${i} ${imgId} 0 R >> >> /Contents ${contentId} 0 R >>`
      ]);
      writeObj(imgId, [
        `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`,
        jpg,
        '\nendstream'
      ]);
      writeObj(contentId, [
        `<< /Length ${contentCmd.length} >>\nstream\n${contentCmd}endstream`
      ]);
    });

    const xrefOffset = cursor;
    const totalObjs = 2 + pages.length * 3;
    let xref = `xref\n0 ${totalObjs + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= totalObjs; id++) {
      xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    }
    xref += `trailer\n<< /Size ${totalObjs + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    pushStr(xref);
    return concatUint8(chunks);
  }

  /* ==================== 2. Canvas A4 高清绘图工具 ==================== */
  function makeA4Canvas() {
    const c = document.createElement('canvas');
    c.width = PAGE_PX_W;
    c.height = PAGE_PX_H;
    const g = c.getContext('2d');
    g.fillStyle = '#FFFFFF';
    g.fillRect(0, 0, PAGE_PX_W, PAGE_PX_H);
    return { canvas: c, g };
  }

  function roundRect(g, x, y, w, h, r, fill, stroke) {
    const rad = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rad, y);
    g.arcTo(x + w, y, x + w, y + h, rad);
    g.arcTo(x + w, y + h, x, y + h, rad);
    g.arcTo(x, y + h, x, y, rad);
    g.arcTo(x, y, x + w, y, rad);
    g.closePath();
    if (fill) { g.fillStyle = fill; g.fill(); }
    if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1.5; g.stroke(); }
  }

  function wrapLines(g, text, maxW) {
    const str = String(text || '');
    if (!str) return [''];
    const lines = [];
    for (const para of str.split('\n')) {
      let cur = '';
      for (const ch of para) {
        if (g.measureText(cur + ch).width > maxW && cur) {
          lines.push(cur);
          cur = ch;
        } else {
          cur += ch;
        }
      }
      if (cur || !lines.length) lines.push(cur);
    }
    return lines;
  }

  function drawHeaderFooter(g, title, subtitle, pageNo, totalPages, footerNote) {
    // Top Accent Bar
    g.fillStyle = '#111827';
    g.fillRect(0, 0, PAGE_PX_W, 132);
    g.fillStyle = '#D8F35A';
    g.fillRect(0, 126, PAGE_PX_W, 6);

    g.fillStyle = '#D8F35A';
    g.font = `600 18px ${FONT_MONO}`;
    g.fillText('PICKLEBALL ACADEMY · 学员成长评估报告', 72, 46);

    g.fillStyle = '#FFFFFF';
    g.font = `700 34px ${FONT_SANS}`;
    g.fillText(title, 72, 92);

    g.fillStyle = '#D1D5DB';
    g.textAlign = 'right';
    g.font = `500 20px ${FONT_SANS}`;
    g.fillText(subtitle, PAGE_PX_W - 72, 92);
    g.textAlign = 'left';

    // Footer
    g.strokeStyle = '#E5E7EB';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(72, PAGE_PX_H - 86);
    g.lineTo(PAGE_PX_W - 72, PAGE_PX_H - 86);
    g.stroke();

    g.fillStyle = '#6B7280';
    g.font = `400 18px ${FONT_SANS}`;
    g.fillText(footerNote || '匹克球教学管理平台 V3.0 · 本报告仅供教学阶段反馈与个人成长追踪参考', 72, PAGE_PX_H - 46);
    g.textAlign = 'right';
    g.font = `500 18px ${FONT_MONO}`;
    g.fillText(`第 ${pageNo} / ${totalPages} 页`, PAGE_PX_W - 72, PAGE_PX_H - 46);
    g.textAlign = 'left';
  }

  function drawStudentBanner(g, y, student, ageGroupName, extraItems) {
    roundRect(g, 72, y, PAGE_PX_W - 144, 114, 14, '#F8FAFC', '#CBD5E1');
    g.fillStyle = '#0F172A';
    g.font = `700 30px ${FONT_SANS}`;
    g.fillText(student.name || '学员', 100, y + 48);

    const metaParts = [
      student.gender === 'female' ? '女' : '男',
      ageGroupName || student.fitnessAgeGroup || '成人',
      student.racketBg ? `球类基础：${student.racketBg}` : '零基础起步',
      `目标：${student.target || '3.0'}`
    ];
    g.fillStyle = '#475569';
    g.font = `500 20px ${FONT_SANS}`;
    g.fillText(metaParts.join('  ·  '), 100, y + 86);

    if (Array.isArray(extraItems) && extraItems.length) {
      let rx = PAGE_PX_W - 100;
      g.textAlign = 'right';
      extraItems.slice().reverse().forEach((item, idx) => {
        g.fillStyle = item.subColor || '#64748B';
        g.font = `500 17px ${FONT_SANS}`;
        g.fillText(item.label, rx, y + 38);
        g.fillStyle = item.color || '#15803D';
        g.font = `700 34px ${FONT_MONO}`;
        g.fillText(item.value, rx, y + 84);
        rx -= (idx === 0 ? 220 : 210);
      });
      g.textAlign = 'left';
    }
    return y + 136;
  }

  function drawRadarOnCanvas(g, cx, cy, r, axes, primaryVals, compareVals, opts) {
    const o = opts || {};
    const n = axes.length;
    const maxVal = o.maxVal || 10;
    const refVal = o.refVal || (maxVal === 10 ? 6 : 60);
    const pt = (idx, val) => {
      const ang = (-Math.PI / 2) + (idx * 2 * Math.PI / n);
      const ratio = Math.max(0.04, Math.min(1, (Number(val) || 0) / maxVal));
      return [cx + Math.cos(ang) * r * ratio, cy + Math.sin(ang) * r * ratio];
    };

    // Grid rings
    [0.25, 0.5, 0.75, 1].forEach((lv, idx) => {
      g.beginPath();
      axes.forEach((_, i) => {
        const [x, y] = pt(i, maxVal * lv);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.closePath();
      g.fillStyle = idx % 2 === 0 ? 'rgba(248,250,252,0.85)' : 'rgba(241,245,249,0.55)';
      g.fill();
      g.strokeStyle = '#CBD5E1';
      g.lineWidth = 1.5;
      g.stroke();
    });

    // Reference line
    g.save();
    g.setLineDash([7, 6]);
    g.beginPath();
    axes.forEach((_, i) => {
      const [x, y] = pt(i, refVal);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.closePath();
    g.strokeStyle = '#D97706';
    g.lineWidth = 2;
    g.stroke();
    g.restore();

    // Axes lines + labels
    axes.forEach((ax, i) => {
      const [x, y] = pt(i, maxVal);
      g.beginPath();
      g.moveTo(cx, cy);
      g.lineTo(x, y);
      g.strokeStyle = '#CBD5E1';
      g.lineWidth = 1.5;
      g.stroke();

      const ang = (-Math.PI / 2) + (i * 2 * Math.PI / n);
      const lx = cx + Math.cos(ang) * (r + 54);
      const ly = cy + Math.sin(ang) * (r + 44);
      const val = primaryVals[i];
      const disp = val == null ? '跳过' : (maxVal === 10 ? Number(val).toFixed(1) : `${Math.round(val)}分`);

      g.textAlign = 'center';
      g.fillStyle = '#0F172A';
      g.font = `700 21px ${FONT_SANS}`;
      g.fillText(ax.label, lx, ly - 4);
      g.fillStyle = val == null ? '#D97706' : '#15803D';
      g.font = `700 19px ${FONT_MONO}`;
      g.fillText(disp, lx, ly + 22);
    });
    g.textAlign = 'left';

    // Compare polygon
    if (Array.isArray(compareVals) && compareVals.length === n) {
      g.save();
      g.setLineDash([8, 5]);
      g.beginPath();
      compareVals.forEach((v, i) => {
        const [x, y] = pt(i, v == null ? 0 : v);
        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
      });
      g.closePath();
      g.fillStyle = 'rgba(37, 99, 235, 0.10)';
      g.fill();
      g.strokeStyle = '#2563EB';
      g.lineWidth = 2.6;
      g.stroke();
      g.restore();
    }

    // Primary polygon
    g.beginPath();
    primaryVals.forEach((v, i) => {
      const [x, y] = pt(i, v == null ? 0 : v);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.closePath();
    g.fillStyle = 'rgba(132, 204, 22, 0.28)';
    g.fill();
    g.strokeStyle = '#4D7C0F';
    g.lineWidth = 4;
    g.stroke();

    primaryVals.forEach((v, i) => {
      if (v == null) return;
      const [x, y] = pt(i, v);
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.fillStyle = '#65A30D';
      g.fill();
      g.lineWidth = 2.5;
      g.strokeStyle = '#FFFFFF';
      g.stroke();
    });
  }

  /* ==================== 3. 技术类别报告数据整理 & 渲染 ==================== */
  function buildTechnicalReportModel(opts) {
    const rpt = opts.report;
    const s = rpt.student;
    const snaps = rpt.snapshots || [];
    const curSnap = opts.currentSnapshot || rpt.latestSnapshot || snaps[0] || null;
    const prevSnap = opts.prevSnapshot || (snaps.length > 1 ? snaps[snaps.length - 1] : curSnap);
    const live = rpt.liveAssessment || { categories: [], modules: [], overallScore: 0 };
    const categories = (curSnap && curSnap.categories) || live.categories || [];
    const modules = (curSnap && curSnap.modules && curSnap.modules.length) ? curSnap.modules : (live.modules || []);
    const prevCatMap = new Map(((prevSnap && prevSnap.categories) || []).map(c => [c.id, Number(c.score) || 0]));
    const prevModMap = new Map(((prevSnap && prevSnap.modules) || []).map(m => [m.code, Number(m.score) || 0]));

    const overallScore = curSnap ? Number(curSnap.overallScore) || 0 : Number(live.overallScore) || 0;
    const prevScore = prevSnap ? Number(prevSnap.overallScore) || 0 : overallScore;
    const overallDelta = Math.round((overallScore - prevScore) * 10) / 10;

    const hasCompare = Boolean(curSnap && prevSnap && curSnap.id !== prevSnap.id);
    const improvedModules = [];
    if (hasCompare) {
      for (const m of modules) {
        const p = prevModMap.has(m.code) ? prevModMap.get(m.code) : 0;
        const d = (Number(m.score) || 0) - p;
        if (d > 0) improvedModules.push({ code: m.code, title: m.title, prev: p, cur: Number(m.score) || 0, delta: d });
      }
      improvedModules.sort((a, b) => b.delta - a.delta);
    }

    const weakestCats = categories.slice().sort((a, b) => a.score - b.score).slice(0, 2);
    const catRows = categories.map(c => {
      const p = prevCatMap.has(c.id) ? prevCatMap.get(c.id) : c.score;
      const d = hasCompare ? Math.round((c.score - p) * 10) / 10 : 0;
      return {
        ...c,
        prevScore: p,
        delta: d
      };
    });

    return {
      student: s,
      ageGroupName: opts.ageGroupName || s.fitnessAgeGroup,
      triggerLabel: opts.triggerLabel || '报告快照',
      reportDate: (curSnap && curSnap.createdAt ? curSnap.createdAt.slice(0, 10) : new Date().toISOString().slice(0, 10)),
      curriculumVersion: (curSnap && curSnap.curriculumVersion) || live.curriculumVersion || '2.2.0',
      summaryNote: (curSnap && curSnap.summaryNote) || '',
      overallScore,
      prevScore,
      overallDelta,
      hasCompare,
      prevDate: prevSnap && prevSnap.createdAt ? prevSnap.createdAt.slice(0, 10) : '',
      catRows,
      modules,
      improvedModules,
      weakestCats,
      masteredCount: modules.filter(m => Number(m.score) >= 2).length,
      totalModules: modules.length
    };
  }

  function renderTechnicalReportPages(opts) {
    const model = buildTechnicalReportModel(opts);
    const scoreLabels = opts.scoreLabels || { 0: '0·不会', 1: '1·初步建立', 2: '2·基本掌握', 3: '3·稳定应用', 4: '4·实战应用', 5: '5·灵活运用' };
    const modsPerPage2 = 34;
    const modPages = [];
    for (let i = 0; i < model.modules.length; i += modsPerPage2) {
      modPages.push(model.modules.slice(i, i + modsPerPage2));
    }
    if (!modPages.length) modPages.push([]);
    const totalPages = 1 + modPages.length;
    const pages = [];

    // Page 1: Overview + 7-Category Progress + 7-Axis Radar + Highlights
    {
      const { canvas, g } = makeA4Canvas();
      drawHeaderFooter(
        g,
        '匹克球技术类别能力评估报告',
        `日期 ${model.reportDate} · 大纲 V${model.curriculumVersion}`,
        1,
        totalPages
      );

      let y = drawStudentBanner(g, 162, model.student, model.ageGroupName, [
        {
          label: '综合技术均分',
          value: `${model.overallScore.toFixed(1)}/10`,
          color: '#3F6212'
        },
        {
          label: model.hasCompare ? `较 ${model.prevDate} 变化` : '已掌握模块',
          value: model.hasCompare
            ? `${model.overallDelta >= 0 ? '+' : ''}${model.overallDelta.toFixed(1)}`
            : `${model.masteredCount}/${model.totalModules}`,
          color: model.hasCompare ? (model.overallDelta >= 0 ? '#15803D' : '#DC2626') : '#1D4ED8'
        }
      ]);

      // Section Title
      g.fillStyle = '#0F172A';
      g.font = `700 26px ${FONT_SANS}`;
      g.fillText('一、7 大技术类别 0–10 分能力评估与雷达分布', 72, y + 32);
      g.fillStyle = '#64748B';
      g.font = `400 18px ${FONT_SANS}`;
      g.fillText(`快照类型：${model.triggerLabel} · 评分结构：初阶必练 6 分 + 进阶选修前 K 项 4 分（折算为 10 分制）`, 72, y + 62);
      y += 84;

      // Left column: 7 Category Bars (x: 72..750)
      let cy = y;
      for (const c of model.catRows) {
        roundRect(g, 72, cy, 678, 102, 10, '#F8FAFC', '#E2E8F0');
        g.fillStyle = '#0F172A';
        g.font = `700 22px ${FONT_SANS}`;
        g.fillText(c.name, 94, cy + 34);

        if (model.hasCompare && c.delta !== 0) {
          const badge = c.delta > 0 ? `+${c.delta}` : `${c.delta}`;
          const bg = c.delta > 0 ? '#DCFCE7' : '#FEE2E2';
          const fg = c.delta > 0 ? '#166534' : '#991B1B';
          roundRect(g, 360, cy + 12, 86, 30, 8, bg);
          g.fillStyle = fg;
          g.font = `700 18px ${FONT_MONO}`;
          g.textAlign = 'center';
          g.fillText(badge, 403, cy + 33);
          g.textAlign = 'left';
        }

        g.textAlign = 'right';
        g.fillStyle = '#3F6212';
        g.font = `700 25px ${FONT_MONO}`;
        g.fillText(`${Number(c.score).toFixed(1)} / 10`, 726, cy + 35);
        g.textAlign = 'left';

        // Progress bar
        roundRect(g, 94, cy + 50, 632, 14, 7, '#E2E8F0');
        const fillW = Math.max(10, Math.round((Math.min(10, Number(c.score) || 0) / 10) * 632));
        roundRect(g, 94, cy + 50, fillW, 14, 7, '#84CC16');

        g.fillStyle = '#475569';
        g.font = `400 17px ${FONT_SANS}`;
        g.fillText(`初阶已掌握 ${c.basicMastered}/${c.basicTotal} 项 · 进阶已涉猎 ${c.advLearned}/${c.advTotal} 项`, 94, cy + 88);
        cy += 114;
      }

      // Right column: Radar Chart Box (x: 774..1416)
      roundRect(g, 774, y, 642, 786, 14, '#FFFFFF', '#E2E8F0');
      g.fillStyle = '#0F172A';
      g.font = `700 22px ${FONT_SANS}`;
      g.textAlign = 'center';
      g.fillText('7 维技术能力雷达图', 1095, y + 42);
      g.textAlign = 'left';

      drawRadarOnCanvas(
        g,
        1095,
        y + 390,
        215,
        model.catRows.map(c => ({ label: c.name.slice(0, 4) })),
        model.catRows.map(c => c.score),
        model.hasCompare ? model.catRows.map(c => c.prevScore) : null,
        { maxVal: 10, refVal: 6 }
      );

      // Legend inside Radar Box
      g.font = `500 18px ${FONT_SANS}`;
      let lx = 815;
      const ly = y + 738;
      g.fillStyle = '#65A30D'; g.fillRect(lx, ly - 13, 24, 6);
      g.fillStyle = '#1E293B'; g.fillText('当前评估', lx + 32, ly);
      lx += 145;
      g.fillStyle = '#D97706'; g.fillRect(lx, ly - 13, 24, 4);
      g.fillStyle = '#1E293B'; g.fillText('6.0 分达标参考', lx + 32, ly);
      if (model.hasCompare) {
        lx += 185;
        g.fillStyle = '#2563EB'; g.fillRect(lx, ly - 13, 24, 4);
        g.fillStyle = '#1E293B'; g.fillText('对比历史快照', lx + 32, ly);
      }

      // Highlights / Coaching Feedback Box at bottom of Page 1
      let hy = cy + 16;
      const boxH = PAGE_PX_H - 110 - hy;
      roundRect(g, 72, hy, PAGE_PX_W - 144, boxH, 14, '#F7FEE7', '#BEF264');
      g.fillStyle = '#365314';
      g.font = `700 23px ${FONT_SANS}`;
      g.fillText('二、阶段进步亮点与下阶段教学重点建议', 98, hy + 40);

      let ty = hy + 78;
      g.fillStyle = '#1E293B';
      g.font = `500 19px ${FONT_SANS}`;

      const noteLines = [];
      if (model.student.injury) {
        noteLines.push(`• 伤病安全提示：${model.student.injury}`);
      }
      if (model.summaryNote) {
        noteLines.push(`• 本次快照说明：${model.summaryNote}`);
      }
      if (model.improvedModules.length) {
        const topUp = model.improvedModules.slice(0, 4).map(m => `${m.code} ${m.title}(${m.prev}→${m.cur})`).join('；');
        noteLines.push(`• 较对比基线显著提升：${topUp}`);
      } else {
        noteLines.push(`• 已掌握技术模块：${model.masteredCount}/${model.totalModules} 项（达到 2 分及以上即基本掌握）。`);
      }
      if (model.weakestCats.length) {
        noteLines.push(`• 下阶段优先突破类别：${model.weakestCats.map(c => `${c.name}(${c.score.toFixed(1)}分)`).join('、')}，建议在 60 分钟课中按木桶短板顺位加强。`);
      }

      for (const item of noteLines) {
        for (const ln of wrapLines(g, item, PAGE_PX_W - 210)) {
          if (ty > PAGE_PX_H - 125) break;
          g.fillText(ln, 98, ty);
          ty += 31;
        }
      }

      pages.push({
        dataUrl: canvas.toDataURL('image/jpeg', 0.92),
        widthPx: PAGE_PX_W,
        heightPx: PAGE_PX_H
      });
    }

    // Page 2+: Module Detail Table
    modPages.forEach((slice, idx) => {
      const { canvas, g } = makeA4Canvas();
      drawHeaderFooter(
        g,
        `${model.student.name} · 全大纲技术模块明细表`,
        `共 ${model.modules.length} 项模块 · 0~5 分量表`,
        2 + idx,
        totalPages
      );

      let y = 166;
      g.fillStyle = '#0F172A';
      g.font = `700 24px ${FONT_SANS}`;
      g.fillText(`三、分模块掌握程度（0=不会 · 1=初步建立 · 2=基本掌握 · 3=稳定应用 · 4=实战应用 · 5=灵活运用）`, 72, y + 18);
      y += 42;

      // Table Header
      roundRect(g, 72, y, PAGE_PX_W - 144, 52, 8, '#1E293B');
      g.fillStyle = '#FFFFFF';
      g.font = `700 19px ${FONT_SANS}`;
      g.fillText('编号', 96, y + 33);
      g.fillText('赛道', 200, y + 33);
      g.fillText('技术模块名称', 320, y + 33);
      g.fillText('已练次数', 930, y + 33);
      g.fillText('当前评分等级', 1120, y + 33);
      y += 56;

      slice.forEach((m, rIdx) => {
        const bg = rIdx % 2 === 0 ? '#FFFFFF' : '#F8FAFC';
        g.fillStyle = bg;
        g.fillRect(72, y, PAGE_PX_W - 144, 50);
        g.strokeStyle = '#E2E8F0';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(72, y + 50);
        g.lineTo(PAGE_PX_W - 72, y + 50);
        g.stroke();

        g.fillStyle = '#0F172A';
        g.font = `700 19px ${FONT_MONO}`;
        g.fillText(m.code, 96, y + 32);

        g.fillStyle = m.track === 'basic' ? '#3F6212' : '#1D4ED8';
        g.font = `600 18px ${FONT_SANS}`;
        g.fillText(m.track === 'basic' ? '初阶' : (m.track === 'advanced' ? '进阶' : m.track), 200, y + 32);

        g.fillStyle = '#0F172A';
        g.font = `500 19px ${FONT_SANS}`;
        const titleTxt = String(m.title || '').length > 26 ? String(m.title).slice(0, 25) + '…' : String(m.title || '');
        g.fillText(titleTxt, 320, y + 32);

        g.fillStyle = '#475569';
        g.font = `500 18px ${FONT_SANS}`;
        g.fillText(m.practiceCount ? `${m.practiceCount} 次` : (Number(m.score) > 0 ? '口头预填' : '未练'), 935, y + 32);

        const sc = Number(m.score) || 0;
        const badgeBg = sc >= 3 ? '#DCFCE7' : (sc >= 2 ? '#ECFCCB' : (sc >= 1 ? '#FEF3C7' : '#F1F5F9'));
        const badgeFg = sc >= 3 ? '#166534' : (sc >= 2 ? '#3F6212' : (sc >= 1 ? '#92400E' : '#475569'));
        roundRect(g, 1115, y + 9, 250, 32, 8, badgeBg);
        g.fillStyle = badgeFg;
        g.font = `700 18px ${FONT_SANS}`;
        g.fillText(scoreLabels[sc] || `${sc} 分`, 1134, y + 31);

        y += 50;
      });

      pages.push({
        dataUrl: canvas.toDataURL('image/jpeg', 0.92),
        widthPx: PAGE_PX_W,
        heightPx: PAGE_PX_H
      });
    });

    return { model, pages };
  }

  /* ==================== 4. 6 维零道具体能报告渲染 ==================== */
  function buildFitnessReportModel(opts) {
    const rpt = opts.report;
    const s = rpt.student;
    const hist = rpt.fitnessHistory || [];
    const latest = opts.fitness || hist[0] || rpt.latestFitness;
    if (!latest) throw new Error('该学员暂无已保存的 6 维体能测评记录');
    const prev = hist.length > 1 ? hist[hist.length - 1] : null;
    const hasCompare = Boolean(prev && prev.id !== latest.id);
    const totalDelta = hasCompare ? Math.round((Number(latest.totalIndex) || 0) - (Number(prev.totalIndex) || 0)) : 0;

    return {
      student: s,
      latest,
      prev,
      hasCompare,
      totalDelta,
      ageGroupName: opts.ageGroupName || latest.ageGroupName || s.fitnessAgeGroup,
      genderName: latest.gender === 'female' ? '女' : '男'
    };
  }

  function renderFitnessReportPages(opts) {
    const model = buildFitnessReportModel(opts);
    const f = model.latest;
    const order = ['power', 'reaction', 'mobility', 'balance', 'flexibility', 'endurance'];
    const dimsOrdered = order.map(k => (f.dimensions || []).find(d => d.key === k)).filter(Boolean);
    const prevOrdered = model.hasCompare
      ? order.map(k => ((model.prev.dimensions || []).find(d => d.key === k) || { score: null }).score)
      : null;

    const { canvas, g } = makeA4Canvas();
    drawHeaderFooter(
      g,
      '匹克球 6 维零道具体能测评报告',
      `测评日期 ${f.testDate} · ${model.genderName} / ${model.ageGroupName}`,
      1,
      1,
      '本测评按教练参考常模与年龄/性别分层换算，仅作教学负荷适配与纵向对比，不作医疗诊断依据。'
    );

    let y = drawStudentBanner(g, 162, model.student, model.ageGroupName, [
      {
        label: '综合体能指数',
        value: `${f.totalIndex}/100`,
        color: '#3F6212'
      },
      {
        label: model.hasCompare ? `较 ${model.prev.testDate} 变化` : '课堂建议 RPE 上限',
        value: model.hasCompare
          ? `${model.totalDelta >= 0 ? '+' : ''}${model.totalDelta}分`
          : `≤ ${f.rpeCap || 7}/10`,
        color: model.hasCompare ? (model.totalDelta >= 0 ? '#15803D' : '#DC2626') : '#1D4ED8'
      }
    ]);

    g.fillStyle = '#0F172A';
    g.font = `700 26px ${FONT_SANS}`;
    g.fillText('一、6 维体能成绩与六边形对比图（全站姿零道具测评）', 72, y + 32);
    g.fillStyle = '#64748B';
    g.font = `400 18px ${FONT_SANS}`;
    g.fillText(`参照组：${model.genderName} · ${model.ageGroupName}（60分为同龄达标参考线；因伤/安全跳过维度不计 0 分）`, 72, y + 62);
    y += 84;

    // Left: 6 Dimension Cards
    let dy = y;
    for (const d of dimsOrdered) {
      roundRect(g, 72, dy, 678, 122, 12, '#F8FAFC', '#E2E8F0');
      g.fillStyle = '#0F172A';
      g.font = `700 23px ${FONT_SANS}`;
      g.fillText(d.name, 94, dy + 36);

      // Badge
      const bg = d.skipped ? '#FEF3C7' : (d.score >= 80 ? '#DCFCE7' : (d.score >= 60 ? '#ECFCCB' : '#FEE2E2'));
      const fg = d.skipped ? '#92400E' : (d.score >= 80 ? '#166534' : (d.score >= 60 ? '#3F6212' : '#991B1B'));
      roundRect(g, 520, dy + 14, 206, 36, 8, bg);
      g.fillStyle = fg;
      g.font = `700 18px ${FONT_MONO}`;
      g.textAlign = 'center';
      g.fillText(d.skipped ? '安全跳过' : `${d.score}分 · ${d.levelText}`, 623, dy + 38);
      g.textAlign = 'left';

      g.fillStyle = '#334155';
      g.font = `500 19px ${FONT_SANS}`;
      const valLine = d.skipped
        ? `跳过原因：${d.skipReason || '安全保护'}（不拉低均分）`
        : `实测结果：${d.rawValue} ${d.unit}${d.altUsed ? '（温和替代折算）' : ''}${d.referenceMedian != null ? ` · 同龄中位参考 ${d.referenceMedian}` : ''}`;
      g.fillText(valLine, 94, dy + 76);

      if (!d.skipped) {
        roundRect(g, 94, dy + 92, 632, 12, 6, '#E2E8F0');
        const fw = Math.max(12, Math.round((Math.min(100, Number(d.score) || 0) / 100) * 632));
        roundRect(g, 94, dy + 92, fw, 12, 6, d.score >= 60 ? '#84CC16' : '#F59E0B');
      }
      dy += 134;
    }

    // Right: Hexagon Radar
    roundRect(g, 774, y, 642, 792, 14, '#FFFFFF', '#E2E8F0');
    g.fillStyle = '#0F172A';
    g.font = `700 22px ${FONT_SANS}`;
    g.textAlign = 'center';
    g.fillText('6 维球场体能六边形雷达图', 1095, y + 42);
    g.textAlign = 'left';

    drawRadarOnCanvas(
      g,
      1095,
      y + 392,
      215,
      dimsOrdered.map(d => ({ label: d.name })),
      dimsOrdered.map(d => d.score),
      prevOrdered,
      { maxVal: 100, refVal: 60 }
    );

    let lx = 815;
    const ly = y + 742;
    g.font = `500 18px ${FONT_SANS}`;
    g.fillStyle = '#65A30D'; g.fillRect(lx, ly - 13, 24, 6);
    g.fillStyle = '#1E293B'; g.fillText('本次测评', lx + 32, ly);
    lx += 145;
    g.fillStyle = '#D97706'; g.fillRect(lx, ly - 13, 24, 4);
    g.fillStyle = '#1E293B'; g.fillText('60 分同龄参考线', lx + 32, ly);
    if (model.hasCompare) {
      lx += 195;
      g.fillStyle = '#2563EB'; g.fillRect(lx, ly - 13, 24, 4);
      g.fillStyle = '#1E293B'; g.fillText('历史首次对比', lx + 32, ly);
    }

    // Bottom: Classroom & Home Prescription + Safety Notes
    let py = dy + 16;
    const boxH = PAGE_PX_H - 110 - py;
    roundRect(g, 72, py, PAGE_PX_W - 144, boxH, 14, '#EFF6FF', '#93C5FD');
    g.fillStyle = '#1E3A8A';
    g.font = `700 23px ${FONT_SANS}`;
    g.fillText('二、60 分钟课堂适配方案、居家零器械处方与安全提示', 98, py + 40);

    let ty = py + 76;
    g.fillStyle = '#0F172A';
    g.font = `500 18.5px ${FONT_SANS}`;
    const lines = [];
    if ((f.trainingHints || []).length) {
      for (const h of f.trainingHints) {
        lines.push(`• 【${h.dimName}(${h.score}分) 课堂联动】${h.classroomHint}`);
        lines.push(`  居家练习：${h.homeTip}`);
      }
    } else {
      lines.push('• 当前 6 维体能表现均衡良好（无 <55 分短板维度），课堂保持常规热身与渐进对抗即可。');
    }
    for (const sn of (f.safetyNotes || [])) {
      lines.push(`• 安全提示：${sn}`);
    }

    for (const item of lines) {
      for (const ln of wrapLines(g, item, PAGE_PX_W - 210)) {
        if (ty > PAGE_PX_H - 122) break;
        g.fillText(ln, 98, ty);
        ty += 29;
      }
    }

    return {
      model,
      pages: [{
        dataUrl: canvas.toDataURL('image/jpeg', 0.92),
        widthPx: PAGE_PX_W,
        heightPx: PAGE_PX_H
      }]
    };
  }

  /* ==================== 5. 独立分享版单文件 HTML 生成器 ==================== */
  function buildTechnicalReportHtml(opts) {
    const model = buildTechnicalReportModel(opts);
    const radarSvg = opts.radarSvg || '';
    const scoreLabels = opts.scoreLabels || { 0: '0·不会', 1: '1·初步建立', 2: '2·基本掌握', 3: '3·稳定应用', 4: '4·实战应用', 5: '5·灵活运用' };
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.student.name)} - 匹克球技术类别能力评估报告</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px;line-height:1.6}
.wrap{max-width:920px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.06)}
.head{background:#111827;color:#fff;padding:24px 28px;border-bottom:4px solid #84cc16}
.head .k{color:#d8f35a;font-size:12px;letter-spacing:.1em;font-family:monospace}
.head h1{margin:6px 0 4px;font-size:22px}
.sub{color:#cbd5e1;font-size:13px}
.sec{padding:20px 28px;border-bottom:1px solid #f1f5f9}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center}
.bar-card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.bar{height:8px;background:#e2e8f0;border-radius:99px;overflow:hidden;margin:6px 0}.bar i{display:block;height:100%;background:#84cc16}
.chip{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#ecfccb;color:#3f6212;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 10px;border-bottom:1px solid #e2e8f0;text-align:left}th{background:#f8fafc}
@media(max-width:720px){.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
  <div class="head"><div class="k">PICKLEBALL ACADEMY · V${esc(model.curriculumVersion)}</div>
    <h1>${esc(model.student.name)} · 技术类别能力评估报告</h1>
    <div class="sub">生成日期：${esc(model.reportDate)} · ${esc(model.triggerLabel)} · 综合均分：<strong>${model.overallScore.toFixed(1)} / 10</strong>${model.hasCompare ? `（较 ${esc(model.prevDate)} ${model.overallDelta >= 0 ? '+' : ''}${model.overallDelta.toFixed(1)}）` : ''}</div>
  </div>
  <div class="sec grid">
    <div>${model.catRows.map(c => `<div class="bar-card"><div style="display:flex;justify-content:space-between"><strong>${esc(c.name)}</strong><span class="chip">${Number(c.score).toFixed(1)} / 10</span></div><div class="bar"><i style="width:${Math.min(100, c.score * 10)}%"></i></div><small style="color:#475569">初阶掌握 ${c.basicMastered}/${c.basicTotal} · 进阶涉猎 ${c.advLearned}/${c.advTotal}</small></div>`).join('')}</div>
    <div style="text-align:center">${radarSvg.replace(/var\(--text\)/g, '#0f172a').replace(/var\(--accent\)/g, '#4d7c0f').replace(/var\(--warn\)/g, '#d97706').replace(/rgba\(255,255,255,0\.1[12]\)/g, '#cbd5e1')}</div>
  </div>
  <div class="sec"><h3>全大纲技术模块明细（共 ${model.modules.length} 项）</h3>
    <table><thead><tr><th>编号</th><th>赛道</th><th>模块名称</th><th>等级</th></tr></thead>
    <tbody>${model.modules.map(m => `<tr><td><code>${esc(m.code)}</code></td><td>${m.track === 'basic' ? '初阶' : esc(m.track)}</td><td>${esc(m.title)}</td><td>${esc(scoreLabels[Number(m.score) || 0] || `${m.score}分`)}</td></tr>`).join('')}</tbody></table>
  </div>
</div></body></html>`;
  }

  function buildFitnessReportHtml(opts) {
    const model = buildFitnessReportModel(opts);
    const f = model.latest;
    const radarSvg = opts.radarSvg || '';
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(model.student.name)} - 6 维零道具体能测评报告</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f8fafc;color:#0f172a;margin:0;padding:24px;line-height:1.6}
.wrap{max-width:920px;margin:0 auto;background:#fff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;box-shadow:0 10px 30px rgba(15,23,42,.06)}
.head{background:#111827;color:#fff;padding:24px 28px;border-bottom:4px solid #84cc16}
.head .k{color:#d8f35a;font-size:12px;letter-spacing:.1em;font-family:monospace}
.head h1{margin:6px 0 4px;font-size:22px}
.sub{color:#cbd5e1;font-size:13px}
.sec{padding:20px 28px;border-bottom:1px solid #f1f5f9}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:center}
.card{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;margin-bottom:8px}
.chip{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;background:#ecfccb;color:#3f6212;font-weight:600}
@media(max-width:720px){.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
  <div class="head"><div class="k">PICKLEBALL COURT FITNESS · 6-DIM</div>
    <h1>${esc(model.student.name)} · 6 维零道具体能测评报告</h1>
    <div class="sub">测评日期：${esc(f.testDate)} · ${esc(model.genderName)} / ${esc(model.ageGroupName)} · 综合指数：<strong>${f.totalIndex} / 100</strong></div>
  </div>
  <div class="sec grid">
    <div>${(f.dimensions || []).map(d => `<div class="card"><div style="display:flex;justify-content:space-between"><strong>${esc(d.name)}</strong><span class="chip">${d.skipped ? '安全跳过' : `${d.score}分 · ${esc(d.levelText)}`}</span></div><div style="font-size:13px;color:#475569;margin-top:4px">${d.skipped ? `跳过原因：${esc(d.skipReason)}` : `实测：${esc(d.rawValue)} ${esc(d.unit)}`}</div></div>`).join('')}</div>
    <div style="text-align:center">${radarSvg.replace(/var\(--text\)/g, '#0f172a').replace(/var\(--accent\)/g, '#4d7c0f').replace(/var\(--warn\)/g, '#d97706').replace(/rgba\(255,255,255,0\.1[12]\)/g, '#cbd5e1')}</div>
  </div>
  <div class="sec"><h3>60 分钟课堂适配与居家处方</h3>
    ${(f.trainingHints || []).length
      ? f.trainingHints.map(h => `<p><strong>${esc(h.dimName)}（${h.score}分）：</strong>${esc(h.classroomHint)}｜<em>居家练习：${esc(h.homeTip)}</em></p>`).join('')
      : '<p>当前 6 维体能发展均衡，保持常规热身与进阶步法训练即可。</p>'}
    <p style="font-size:12px;color:#64748b">${(f.safetyNotes || []).map(esc).join('<br>')}</p>
  </div>
</div></body></html>`;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    return url;
  }

  const api = {
    version: '3.0.4',
    PAGE_PX_W,
    PAGE_PX_H,
    buildPdfFromJpegPages,
    buildTechnicalReportModel,
    buildFitnessReportModel,
    renderTechnicalReportPages,
    renderFitnessReportPages,
    buildTechnicalReportHtml,
    buildFitnessReportHtml,
    generateTechnicalPdfBlob(opts) {
      const { model, pages } = renderTechnicalReportPages(opts);
      const pdfBytes = buildPdfFromJpegPages(pages);
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const filename = `${model.student.name}-技术类别能力报告-${model.reportDate}.pdf`;
      return { blob, filename, pages, model };
    },
    generateFitnessPdfBlob(opts) {
      const { model, pages } = renderFitnessReportPages(opts);
      const pdfBytes = buildPdfFromJpegPages(pages);
      const blob = new Blob([pdfBytes], { type: 'application/pdf' });
      const filename = `${model.student.name}-6维体能测评报告-${model.latest.testDate}.pdf`;
      return { blob, filename, pages, model };
    },
    downloadBlob
  };

  root.PKB_REPORT = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
