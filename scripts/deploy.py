#!/usr/bin/env python3
"""匹克球教学管理中台 · SSH 部署与真机验证。

流程遵循 ssh-deploy-verify：SSH 连接 -> 远端备份 -> SFTP 上传 -> 语法校验
-> 额外命令(环境/服务配置) -> systemd 重启 -> curl 真机验证 -> 日志。

针对本项目的适配：
- 只用 `git ls-files` 白名单打包，.env / data/ / .git / .deploy.env 绝不上传
- 服务器无 Node 时，把官方 Node 22 二进制装到 /opt/node22（不污染 apt）
- 保留服务器上已有的 data/（数据库、密钥），不覆盖
- 生成 systemd unit；若配置了域名且 Nginx 可用，增加 80 端口反代（不改动既有站点）
- 任一步失败自动回滚到备份目录

凭据只从 .deploy.env（已 gitignore）读取，脚本内不写死任何 IP / 密码。
依赖：paramiko
"""
from __future__ import annotations

import datetime
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
NODE_VER = '22.22.2'
NODE_URL = f'https://nodejs.org/dist/v{NODE_VER}/node-v{NODE_VER}-linux-x64.tar.xz'
NODE_URL_MIRROR = f'https://npmmirror.com/mirrors/node/v{NODE_VER}/node-v{NODE_VER}-linux-x64.tar.xz'


def load_cfg() -> dict:
    p = ROOT / '.deploy.env'
    if not p.exists():
        sys.exit('缺少 .deploy.env，请先复制 .deploy.env.example 并填写')
    cfg = {}
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            cfg[k.strip()] = v.strip()
    for k in ('DEPLOY_HOST', 'DEPLOY_USER'):
        if not cfg.get(k):
            sys.exit(f'.deploy.env 缺少 {k}')
    if not cfg.get('DEPLOY_KEY') and not cfg.get('DEPLOY_PWD'):
        sys.exit('.deploy.env 需要 DEPLOY_KEY 或 DEPLOY_PWD')
    cfg.setdefault('DEPLOY_PORT', '22')
    cfg.setdefault('DEPLOY_DIR', '/opt/pickleball')
    cfg.setdefault('DEPLOY_BIND', '0.0.0.0')
    cfg.setdefault('DEPLOY_APP_PORT', '8787')
    cfg.setdefault('DEPLOY_SERVICE', 'pickleball')
    return cfg


def build_package(ts: str) -> Path:
    """只用 git 受控文件打包，天然排除 .env / data / .git。"""
    raw = subprocess.check_output(
        ['git', '-c', 'core.quotepath=false', 'ls-files', '-z'], cwd=ROOT
    ).decode('utf-8')
    files = [f for f in raw.split('\0') if f]
    blocked = ('.env', '.deploy.env', 'data/', '.git')
    files = [f for f in files if not any(f == b or f.startswith(b) for b in blocked)]
    pkg = ROOT / f'pkb-release-{ts}.tar.gz'
    with tarfile.open(pkg, 'w:gz') as tf:
        for f in files:
            tf.add(ROOT / f, arcname=f)
    print(f'[本地] 白名单打包 {len(files)} 个文件 -> {pkg.name} ({pkg.stat().st_size} bytes)')
    return pkg


def connect(cfg: dict):
    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    args = dict(hostname=cfg['DEPLOY_HOST'], port=int(cfg['DEPLOY_PORT']),
                username=cfg['DEPLOY_USER'], timeout=25,
                look_for_keys=False, allow_agent=False)
    if cfg.get('DEPLOY_KEY'):
        args['key_filename'] = str(Path(cfg['DEPLOY_KEY']).expanduser())
    else:
        args['password'] = cfg['DEPLOY_PWD']
    cli.connect(**args)
    print(f"[1] SSH 连接成功 {cfg['DEPLOY_USER']}@{cfg['DEPLOY_HOST']}:{cfg['DEPLOY_PORT']}")
    return cli


def sh(cli, cmd: str, label: str, timeout: int = 300, check: bool = True):
    _, out, err = cli.exec_command(cmd, timeout=timeout)
    text = (out.read().decode('utf-8', 'replace') + err.read().decode('utf-8', 'replace')).strip()
    rc = out.channel.recv_exit_status()
    if text:
        print(f'    {label}: {text[:1200]}')
    if check and rc != 0:
        raise RuntimeError(f'{label} 失败 (exit {rc})')
    return rc, text


def put_text(sftp, content: str, remote_tmp: str, target: str):
    with sftp.open(remote_tmp, 'w') as fh:
        fh.write(content)
    sftp.chmod(remote_tmp, 0o644)


def main():
    cfg = load_cfg()
    ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    d = cfg['DEPLOY_DIR'].rstrip('/')
    svc = cfg['DEPLOY_SERVICE']
    port = cfg['DEPLOY_APP_PORT']
    bind = cfg['DEPLOY_BIND']
    domain = cfg.get('DEPLOY_DOMAIN', '')
    remote_tmp = f'/tmp/pkb-release-{ts}.tar.gz'
    remote_new = f'{d}.new.{ts}'
    remote_bak = f'{d}.bak.{ts}'
    remote_bak_tar = f'{d}.bak.{ts}.tar.gz'
    nginx_conf = '/etc/nginx/conf.d/pickleball.conf'
    unit = f'/etc/systemd/system/{svc}.service'

    pkg = build_package(ts)
    cli = connect(cfg)
    sftp = cli.open_sftp()
    backup_done = False
    nginx_added = False
    nginx_created = False
    nginx_https = False
    try:
        # ---- [2] 远端备份（首次部署无旧目录则跳过）----
        print('[2] 远端备份')
        rc, _ = sh(cli, f'test -d {d}', 'check-target', check=False)
        if rc == 0:
            sh(cli, f"tar czf {remote_bak_tar} -C {d} . 2>/dev/null && echo BACKUP_OK || echo BACKUP_FAIL",
               'tar-backup')
            sh(cli, f"test -f {nginx_conf} && cp {nginx_conf} {nginx_conf}.bak.{ts} || true",
               'nginx-conf-backup', check=False)
            backup_done = True
            print(f'    备份: {remote_bak_tar}')
        else:
            print('    首次部署，远端无旧版本，跳过备份')

        # ---- [3] SFTP 上传 ----
        print('[3] SFTP 上传发布包')
        sftp.put(str(pkg), remote_tmp)
        print(f'    UPLOADED -> {remote_tmp} ({sftp.stat(remote_tmp).st_size} bytes)')

        # ---- [4] 环境：Node 22（仅在缺失时安装到 /opt/node22）----
        print('[4] 运行环境准备')
        rc, ver = sh(cli, '/opt/node22/bin/node -v 2>/dev/null || echo none', 'node-probe', check=False)
        if ver != f'v{NODE_VER}':
            sh(cli,
               f"set -e; curl -fL --retry 3 --max-time 300 -o /tmp/node-{NODE_VER}.tar.xz '{NODE_URL}' "
               f"|| curl -fL --retry 3 --max-time 300 -o /tmp/node-{NODE_VER}.tar.xz '{NODE_URL_MIRROR}'; "
               f"mkdir -p /opt/node22; tar -xJf /tmp/node-{NODE_VER}.tar.xz -C /opt/node22 --strip-components=1; "
               f"/opt/node22/bin/node -v",
               'install-node22', timeout=420)
        sh(cli, '/opt/node22/bin/node -v', 'node-version')

        # ---- [5] 解压 + 保留旧 data + 原子切换 ----
        print('[5] 解压与切换')
        sh(cli,
           f"set -e; mkdir -p {remote_new}; tar xzf {remote_tmp} -C {remote_new}; "
           f"if [ -d {d}/data ]; then mv {d}/data {remote_new}/data; fi; "
           f"if [ -d {d} ]; then mv {d} {remote_bak}; fi; "
           f"mv {remote_new} {d}; mkdir -p {d}/data; "
           f"id -u pkb >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin pkb; "
           f"chown -R pkb:pkb {d}; echo SWITCH_OK",
           'unpack-switch')
        backup_done = True

        # ---- [6] 上线前语法校验 ----
        print('[6] Node 语法校验')
        sh(cli,
           f"cd {d} && find backend database frontend scripts -name '*.js' -print0 | "
           f"xargs -0 -n1 /opt/node22/bin/node --check && echo COMPILE_OK",
           'node-check', timeout=240)
        sh(cli, f'cd {d} && /opt/node22/bin/node --check backend/src/index.js && echo ENTRY_OK',
           'entry-check')

        # ---- [7] 生成 systemd unit ----
        print('[7] 配置 systemd 服务')
        _, has_nginx = sh(cli, 'command -v nginx >/dev/null 2>&1 && echo yes || echo no',
                          'nginx-available', check=False)
        # 域名 + Nginx 反代时应用只监听本机，收敛公网暴露面
        unit_bind = '127.0.0.1' if (domain and has_nginx == 'yes') else bind
        print(f'    应用监听 {unit_bind}:{port}' +
              ('（公网经 Nginx 80 反代）' if unit_bind == '127.0.0.1' else ''))
        unit_content = f"""[Unit]
Description=Pickleball Academy Management
After=network.target

[Service]
Type=simple
User=pkb
Group=pkb
WorkingDirectory={d}
Environment=NODE_ENV=production
Environment=HOST={unit_bind}
Environment=PORT={port}
Environment=DB_FILE=data/pickleball.db
ExecStart=/opt/node22/bin/node backend/src/index.js
Restart=always
RestartSec=3
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
"""
        put_text(sftp, unit_content, f'/tmp/{svc}.service.{ts}', unit)
        sh(cli, f"mv /tmp/{svc}.service.{ts} {unit} && chmod 644 {unit} && echo UNIT_OK", 'install-unit')

        # ---- [8] Nginx 反代（域名场景；保留 certbot 已配置的 HTTPS）----
        if domain:
            print('[8] 配置 Nginx 反代')
            if has_nginx == 'yes':
                _, state = sh(cli,
                              f"if grep -q 'ssl_certificate' {nginx_conf} 2>/dev/null; then echo managed; "
                              f"elif [ -f /etc/letsencrypt/live/{domain}/fullchain.pem ]; then echo cert-only; "
                              f"else echo none; fi",
                              'nginx-https-state', check=False)
                nginx_https = state in ('managed', 'cert-only')
                server_names = domain + (f' www.{domain}' if not domain.startswith('www.') else '')
                location = f"""    location / {{
        proxy_pass http://127.0.0.1:{port};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }}
"""
                if state == 'managed':
                    print('    检测到 certbot 管理的 HTTPS 配置，保留不覆盖（避免重新部署丢失证书）')
                    sh(cli, 'nginx -t >/dev/null 2>&1 && systemctl reload nginx && echo NGINX_OK',
                       'nginx-reload')
                else:
                    if state == 'cert-only':
                        print('    检测到已有证书但缺 Nginx 配置，重建 443 + 80 跳转')
                        conf = f"""server {{
    server_name {server_names};
{location}
    listen 443 ssl;
    ssl_certificate /etc/letsencrypt/live/{domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/{domain}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
}}
server {{
    listen 80;
    server_name {server_names};
    return 301 https://$host$request_uri;
}}
"""
                    else:
                        conf = f"""server {{
    listen 80;
    server_name {server_names};
{location}}}
"""
                    put_text(sftp, conf, f'/tmp/pickleball-nginx.{ts}', nginx_conf)
                    sh(cli, f"mv /tmp/pickleball-nginx.{ts} {nginx_conf} && nginx -t 2>&1 | tail -2 && "
                            f"systemctl reload nginx && echo NGINX_OK", 'nginx-reload')
                    nginx_created = True
                nginx_added = True
            else:
                print('    未检测到 nginx，跳过反代')

        # ---- [9] 启动服务并确认 active ----
        print('[9] 重启服务')
        sh(cli, f"systemctl daemon-reload && systemctl enable --now {svc} >/dev/null 2>&1; "
                f"systemctl restart {svc}; sleep 4; systemctl is-active {svc}", 'restart', timeout=120)

        # ---- [10] 真机 HTTP 验证（带重试）----
        print('[10] 真机验证')
        health = f'http://127.0.0.1:{port}/api/v1/health'
        code = ''
        for i in range(10):
            _, code = sh(cli, f"curl -s -o /dev/null -w '%{{http_code}}' {health}",
                         f'health-try-{i + 1}', check=False)
            if code == '200':
                break
            time.sleep(2)
        if code != '200':
            raise RuntimeError(f'健康检查未通过: HTTP {code}')
        _, body = sh(cli, f'curl -s {health}', 'health-body', check=False)
        print(f'    HEALTH_OK {health} -> {body[:200]}')
        for label, url in [('首页', f'http://127.0.0.1:{port}/'),
                           ('api.js', f'http://127.0.0.1:{port}/api.js')]:
            _, c = sh(cli, f"curl -s -o /dev/null -w '%{{http_code}}' '{url}'", label, check=False)
            print(f'    {label} -> HTTP {c}')
        if domain and nginx_added:
            if nginx_https:
                _, c = sh(cli,
                          f"curl -sk -H 'Host: {domain}' -o /dev/null -w '%{{http_code}}' "
                          f"'https://127.0.0.1/api/v1/health'", 'nginx-HTTPS路由', check=False)
                print(f'    HTTPS 域名反代 -> HTTP {c}')
                _, c2 = sh(cli,
                           f"curl -s -H 'Host: {domain}' -o /dev/null -w '%{{http_code}}' "
                           f"'http://127.0.0.1/api/v1/health'", 'nginx-HTTP跳转', check=False)
                print(f'    HTTP 跳转（应为 301）-> HTTP {c2}')
            else:
                _, c = sh(cli,
                          f"curl -s -H 'Host: {domain}' -o /dev/null -w '%{{http_code}}' "
                          f"'http://127.0.0.1/api/v1/health'", 'nginx-域名路由', check=False)
                print(f'    域名反代 -> HTTP {c}')

        # ---- [11] 初始管理员凭据 + 日志 ----
        print('[11] 初始凭据与日志')
        _, pw = sh(cli, f"cat {d}/data/initial-admin.txt 2>/dev/null || echo '<未生成>'",
                   'initial-admin', check=False)
        print(f'    首次登录信息：{pw}')
        _, logs = sh(cli, f'journalctl -u {svc} -n 12 --no-pager 2>/dev/null | tail -12',
                     'journal', check=False)
        print('    最近日志：\n' + '\n'.join('      ' + x for x in logs.splitlines()[-12:]))

        print('\nDEPLOY_VERIFY_DONE')
        print(f'发布包: {remote_tmp}')
        print(f'回滚目录: {remote_bak if backup_done else "<首次部署无>"}'
              + (f' / {remote_bak_tar}' if backup_done else ''))
        print(f'访问: http://{domain or cfg["DEPLOY_HOST"]}' +
              ('' if domain and nginx_added else f':{port}'))

    except Exception as exc:
        print(f'\n!!! 部署失败: {exc}')
        print('=== 自动回滚 ===')
        try:
            if backup_done:
                sh(cli, f"test -d {remote_bak} && (rm -rf {d}.failed.{ts}; mv {d} {d}.failed.{ts}; "
                        f"mv {remote_bak} {d}) || true", 'rollback-dir', check=False)
            if nginx_created:
                sh(cli, f"rm -f {nginx_conf}; nginx -t >/dev/null 2>&1 && systemctl reload nginx || true",
                   'rollback-nginx', check=False)
            sh(cli, f"systemctl daemon-reload; systemctl restart {svc} 2>/dev/null || true",
               'rollback-service', check=False)
            print('回滚完成')
        except Exception as rb:
            print('回滚过程异常:', rb)
        sys.exit(1)
    finally:
        sftp.close()
        cli.close()


if __name__ == '__main__':
    main()
