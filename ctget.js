(() => {
    /*
     * 关键修复（2026-10 城通接口变更）：
     *   旧接口 get_file_url.php?app=0&acheck=2 已废弃 —— 现在固定返回 HTTP 200 + 空 body，
     *   于是 JSON.parse("") 抛 "SyntaxError: Unexpected end of JSON input"。
     *   新接口为 get_down_url.php，且【必须】带上 getfile.php 返回的 start_time
     *   （缺了它同样返回空 body），成功时返回 { code:200, downurl, file_size, file_name }。
     */
    const ctfile = {
        version: () => { return "2.6.10" },

        /*
         * 新增：统一的「请求 + 解析」封装。
         * 原版直接写 JSON.parse(await (await fetch(...)).text())，
         * 只要接口返回空内容（被城通风控/Cloudflare 校验、限流、未登录、跨域被挡），
         * JSON.parse("") 就会抛 SyntaxError: Unexpected end of JSON input。
         * 这里先校验 HTTP 状态和响应体是否为空，再解析，并把错误变成可读文案。
         */
        requestJSON: async (url, options = {}) => {
            const res = await fetch(url, options);
            const text = await res.text();
            if (!text) {
                throw new Error("接口返回空内容 (HTTP " + res.status + ")，通常是触发了城通风控/Cloudflare 校验、被限流，或未登录");
            }
            try {
                return JSON.parse(text);
            } catch (e) {
                throw new Error("接口返回的不是 JSON (HTTP " + res.status + "): " + text.slice(0, 200));
            }
        },

        getByLink: (link, password, token, firstcallback) => {
            console.warn("ctfile.getByLink is deprecated, use ctfile.getByID instead.");
            return ctfile.getByID(link.substring(link.lastIndexOf("/") + 1, (link.lastIndexOf("?") == -1) ? undefined : link.lastIndexOf("?")), (link.lastIndexOf("p=") == -1) ? password : link.substring(link.lastIndexOf("p=") + 2), token, firstcallback);
        },

        getByID: async (fileid, password, token = (ctfile.buildToken ? ctfile.buildToken() : ""), firstCallback, preferNode = "dx") => {
            const origin = () => {
                // 兼容 node.js：原版直接引用 document，在无 DOM 环境会抛 ReferenceError
                if (typeof document !== "undefined" && document.location.origin != "file://") {
                    return document.location.origin;
                }
                return "https://ctfile.qinlili.workers.dev";
            };

            const path = id => (id.split("-").length === 2 ? "file" : "f");

            // 注意：Origin / Referer 属于浏览器「禁止 JS 设置」的请求头，
            // 这里写了也不会生效，真实 Referer 由页面自身决定。保留仅为兼容旧逻辑。
            const originHeaders = { "origin": origin(), "referer": origin() };

            try {
                const jsonText = await ctfile.requestJSON(
                    "https://webapi.ctfile.com/getfile.php?path=" + path(fileid) +
                    "&f=" + fileid +
                    "&passcode=" + (password || "") +
                    "&token=" + token +
                    "&r=" + Math.random() +
                    "&ref=" + encodeURIComponent(origin()),
                    { headers: originHeaders, credentials: "include" }
                );

                if (jsonText.code != 200) {
                    return {
                        "success": false,
                        "errormsg": (jsonText.file && jsonText.file.message) || jsonText.message || ("接口返回 code=" + jsonText.code)
                    };
                }

                const file = jsonText.file || {};
                const base = {
                    "name": file.file_name,
                    "size": file.file_size,
                    "time": file.file_time
                };
                if (firstCallback) firstCallback(base);

                if (file.is_vip == 1) {
                    let url = false;
                    switch (preferNode) {
                        case "dx": if (file.vip_dx_url) { url = file.vip_dx_url; break; }
                        case "yd": if (file.vip_yd_url) { url = file.vip_yd_url; break; }
                        case "lt": if (file.vip_lt_url) { url = file.vip_lt_url; break; }
                        default:
                        case "us": if (file.us_downurl_a) { url = file.us_downurl_a; break; }
                    }
                    if (!url) {
                        return Object.assign({ "success": false, "errormsg": "解析结果没有可用的链接！" }, base);
                    }
                    return Object.assign({ "success": true, "link": url }, base);
                }

                const jsonText2 = await ctfile.requestJSON(
                    "https://webapi.ctfile.com/get_down_url.php" +
                    "?uid=" + file.userid +
                    "&fid=" + file.file_id +
                    "&file_chk=" + file.file_chk +
                    "&start_time=" + (file.start_time || 0) +
                    "&wait_seconds=" + (file.wait_seconds || 0) +
                    "&rd=" + Math.random(),
                    { headers: originHeaders, credentials: "include" }
                );

                if (jsonText2.code == 200 && jsonText2.downurl) {
                    return Object.assign({ "success": true, "link": jsonText2.downurl }, base);
                }
                if (jsonText2.code == 423) {
                    return Object.assign({ "success": false, "errormsg": "该文件需要提取码（或提取码不正确）。" }, base);
                }
                return Object.assign({ "success": false, "errormsg": jsonText2.message || ("接口返回 code=" + jsonText2.code) }, base);

            } catch (e) {
                // 任何网络/解析异常都不再向上抛，统一返回结构化结果
                return {
                    "success": false,
                    "errormsg": (e && e.message) ? e.message : String(e)
                };
            }
        }
    };

    if (window.ModuleLoader && ModuleLoader.useRedbankLoaderGlobal) {
        ModuleLoader.loadLocal({ ctfile });
    } else {
        window.ctfile = ctfile;
    }
})();
