#!/usr/bin/env python3
"""把一个版本加进 Sparkle 的 appcast.xml（macOS 自动更新清单），只保留最近的 KEEP 个版本。

用法：update-appcast.py <appcast.xml> --version 0.2.0-beta.1 --build 1951 --url <zip 地址> --length <字节数> --signature <EdDSA 签名> --link <发布页>
"""
import argparse
import os
import xml.etree.ElementTree as ET
from email.utils import formatdate

SPARKLE = "http://www.andymatuschak.org/xml-namespaces/sparkle"
KEEP = 20
ET.register_namespace("sparkle", SPARKLE)


def q(tag: str) -> str:
    return f"{{{SPARKLE}}}{tag}"


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("appcast")
    for name in ("version", "build", "url", "length", "signature", "link"):
        p.add_argument(f"--{name}", required=True)
    a = p.parse_args()

    if os.path.exists(a.appcast):
        tree = ET.parse(a.appcast)
        channel = tree.getroot().find("channel")
    else:
        rss = ET.Element("rss", {"version": "2.0"})
        channel = ET.SubElement(rss, "channel")
        ET.SubElement(channel, "title").text = "OpenHane"
        tree = ET.ElementTree(rss)

    for old in channel.findall("item"):
        if old.findtext(q("version")) == a.build:
            channel.remove(old)

    item = ET.Element("item")
    ET.SubElement(item, "title").text = f"OpenHane {a.version}"
    ET.SubElement(item, "pubDate").text = formatdate(usegmt=True)
    ET.SubElement(item, "link").text = a.link
    ET.SubElement(item, q("version")).text = a.build
    ET.SubElement(item, q("shortVersionString")).text = a.version
    if "-beta." in a.version:
        ET.SubElement(item, q("channel")).text = "beta"
    ET.SubElement(item, "enclosure", {"url": a.url, "length": a.length, "type": "application/octet-stream", q("edSignature"): a.signature})

    items = channel.findall("item")
    first = list(channel).index(items[0]) if items else len(channel)
    channel.insert(first, item)
    for old in channel.findall("item")[KEEP:]:
        channel.remove(old)

    ET.indent(tree)
    tree.write(a.appcast, encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    main()
