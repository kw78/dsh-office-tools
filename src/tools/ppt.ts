/**
 * PowerPoint (.pptx) tools over the self-contained OOXML container (1.0.0).
 *
 * `ppt_create` builds a widescreen deck as an ASCII-safe STORE package
 * published through the official fs channel — no third-party library, no
 * binary package parts. Pictures are LINKED (`a:blip r:link`): the model
 * fully controls placement (x/y/w/h inches, contain/cover cropping, alt
 * text), the image file stays a workspace artifact, and intrinsic sizes are
 * sniffed from PNG/JPEG/GIF headers so omitted dimensions default to natural
 * size. The create result echoes every element's landing geometry, and both
 * tools render a text wireframe sketch so the model can SEE the composition.
 *
 * `ppt_read` reads any real-world deck and returns, per slide in document
 * order: paragraphs, tables, notes, image counts/alt texts — plus an
 * `elements` array with every shape's bounding box in inches and the deck's
 * canvas size. True raster rendering stays out of scope on purpose: it would
 * need a headless renderer (a subprocess plus a binary dependency), which is
 * exactly what the dependency-free, no-commands contract forbids.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { buildAsciiZip, readZip, readZipXmlPart, type ZipPart } from '../asciizip.ts'
import {
  assertMayCreate, MAX_TEXT_CHARS, readOfficeBytes, resolveOfficePath, saveOfficeText,
} from '../fschannel.ts'
import type { FsContext, ResolvedOfficePath } from '../fschannel.ts'
import { sniffImageSize } from '../imgsize.ts'
import { decodeXmlEntities, encodeXmlAttribute, encodeXmlText, FILE_RESULT_SCHEMA } from './shared.ts'

/** Linked image formats whose headers carry intrinsic pixel sizes. */
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif'] as const

/** One linked image may not exceed this size. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Safety cap for images on a single slide. */
const MAX_IMAGES_PER_SLIDE = 20

/** EMU per inch and per pixel at the OOXML-standard 96 dpi. */
const EMU_PER_INCH = 914400
const EMU_PER_PIXEL = 9525

/** Widescreen 13.33 x 7.5 inch canvas. */
const SLIDE_WIDTH_INCHES = 40 / 3
const SLIDE_HEIGHT_INCHES = 7.5
const SLIDE_WEMU = Math.round(SLIDE_WIDTH_INCHES * EMU_PER_INCH)
const SLIDE_HEMU = Math.round(SLIDE_HEIGHT_INCHES * EMU_PER_INCH)

interface SlideImageSpec {
  path: string
  x?: number
  y?: number
  w?: number
  h?: number
  sizing?: 'contain' | 'cover'
  alt?: string
}

interface SlideSpec {
  title?: string
  paragraphs?: string[]
  bullets?: string[]
  notes?: string
  images?: SlideImageSpec[]
}

interface PptCreateArgs {
  path: string
  title?: string
  slides?: SlideSpec[]
  overwrite?: boolean
}

interface PptReadArgs {
  path: string
  max_chars?: number
}

/** One placed element, echoed by create and parsed back by read. */
export interface SlideElementBox {
  type: 'text' | 'bullets' | 'image' | 'table'
  xIn: number
  yIn: number
  wIn: number
  hIn: number
  text?: string
  items?: string[]
  alt?: string
  path?: string
  sizing?: 'contain' | 'cover'
}

/** A linked image after path resolution and intrinsic-size sniffing. */
interface PlacedImage extends SlideElementBox {
  type: 'image'
  target: string
  pixelWidth?: number
  pixelHeight?: number
  crop?: { l: number; t: number; r: number; b: number }
}

const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const P_NS = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const R_NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
const REL_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships"'
const CT_NS = 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types"'

function relationshipXml(id: string, type: string, target: string, external: boolean): string {
  return `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/${type}" Target="${encodeXmlAttribute(target)}"${external ? ' TargetMode="External"' : ''}/>`
}

function shapeTree(children: string): string {
  return '<p:spTree>'
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + `${children}</p:spTree>`
}

function roundedInches(emu: number): number {
  return Math.round((emu / EMU_PER_INCH) * 100) / 100
}

/** One plain text box with explicit geometry; returns its XML and echo box. */
function textBoxPart(id: number, x: number, y: number, w: number, h: number, fontSizePt: number, paragraphs: string[], bold: boolean, centered: boolean): { xml: string; box: SlideElementBox } {
  const runs = paragraphs.map(paragraph =>
    `<a:p>${centered ? '<a:pPr algn="ctr"/>' : ''}<a:r><a:rPr lang="en-US" sz="${fontSizePt * 100}" b="${bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr><a:t xml:space="preserve">${encodeXmlText(paragraph)}</a:t></a:r></a:p>`).join('')
  const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x * EMU_PER_INCH)}" y="${Math.round(y * EMU_PER_INCH)}"/><a:ext cx="${Math.round(w * EMU_PER_INCH)}" cy="${Math.round(h * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:spAutoFit/></a:bodyPr><a:lstStyle/>${runs}</p:txBody></p:sp>`
  const text = paragraphs.join(' | ')
  return { xml, box: { type: 'text', xIn: Math.round(x * 100) / 100, yIn: Math.round(y * 100) / 100, wIn: Math.round(w * 100) / 100, hIn: Math.round(h * 100) / 100, text: text.length > 120 ? `${text.slice(0, 117)}...` : text } }
}

/** One bullet-list text box; returns its XML and echo box. */
function bulletBoxPart(id: number, x: number, y: number, w: number, h: number, items: string[]): { xml: string; box: SlideElementBox } {
  const paragraphs = items.map(item =>
    `<a:p><a:pPr marL="228600" indent="-228600"><a:lnSpc><a:spcPct val="120000"/></a:lnSpc><a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="${encodeXmlAttribute('\u2022')}"/></a:pPr>`
    + `<a:r><a:rPr lang="en-US" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="1F3864"/></a:solidFill></a:rPr><a:t xml:space="preserve">${encodeXmlText(item)}</a:t></a:r></a:p>`).join('')
  const xml = `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Bullets ${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x * EMU_PER_INCH)}" y="${Math.round(y * EMU_PER_INCH)}"/><a:ext cx="${Math.round(w * EMU_PER_INCH)}" cy="${Math.round(h * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" rtlCol="0"/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  return { xml, box: { type: 'bullets', xIn: Math.round(x * 100) / 100, yIn: Math.round(y * 100) / 100, wIn: Math.round(w * 100) / 100, hIn: Math.round(h * 100) / 100, items } }
}

/** One linked picture with explicit or fitted geometry and optional cover crop. */
function linkedPicturePart(id: number, image: PlacedImage, relId: string): string {
  const crop = image.crop === undefined ? '' : `<a:srcRect l="${image.crop.l}" t="${image.crop.t}" r="${image.crop.r}" b="${image.crop.b}"/>`
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${encodeXmlAttribute(image.alt ?? '')}"/>`
    + '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + `<p:blipFill><a:blip r:link="${relId}"/>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(image.xIn * EMU_PER_INCH)}" y="${Math.round(image.yIn * EMU_PER_INCH)}"/><a:ext cx="${Math.round(image.wIn * EMU_PER_INCH)}" cy="${Math.round(image.hIn * EMU_PER_INCH)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

function slideXml(shapes: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<p:sld ${A_NS} ${R_NS} ${P_NS}><p:cSld>${shapeTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
}

/** Notes page: body placeholder carrying the speaker text. */
function notesSlideXml(notes: string): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<p:notes ${A_NS} ${R_NS} ${P_NS}><p:cSld><p:spTree>`
    + '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
    + '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>'
    + '<p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="5029200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>'
    + `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" dirty="0"/><a:t xml:space="preserve">${encodeXmlText(notes)}</a:t></a:r></a:p></p:txBody></p:sp>`
    + '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>'
}

const THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<a:theme ${A_NS} name="Office"><a:themeElements>`
  + '<a:clrScheme name="Office">'
  + '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
  + '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
  + '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
  + '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
  + '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
  + '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
  + '</a:clrScheme>'
  + '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
  + '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
  + '<a:fmtScheme name="Office">'
  + '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
  + '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="105000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>'
  + '</a:fillStyleLst>'
  + '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  + '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
  + '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
  + '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
  + '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
  + '</a:fmtScheme></a:themeElements></a:theme>'

const SLIDE_MASTER_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<p:sldMaster ${A_NS} ${R_NS} ${P_NS}>`
  + `<p:cSld name="Office">${shapeTree('')}</p:cSld>`
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>'
  + '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle>'
  + '<p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle>'
  + '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>'
  + '</p:sldMaster>'

const SLIDE_LAYOUT_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<p:sldLayout ${A_NS} ${R_NS} ${P_NS} type="blank" preserve="1">`
  + `<p:cSld name="Blank">${shapeTree('')}</p:cSld>`
  + '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'

const NOTES_MASTER_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<p:notesMaster ${A_NS} ${R_NS} ${P_NS}>`
  + `<p:cSld name="Notes">${shapeTree('')}</p:cSld>`
  + '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'
  + '</p:notesMaster>'

function contentTypesXml(slideCount: number, notesCount: number): string {
  const slides = Array.from({ length: slideCount }, (_, index) =>
    `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')
  const notes = Array.from({ length: notesCount }, (_, index) =>
    `<Override PartName="/ppt/notesSlides/notesSlide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>`).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Types ${CT_NS}>`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>'
    + '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>'
    + '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>'
    + '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/>'
    + '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>'
    + slides + notes
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    + '</Types>'
}

function presentationXml(slideCount: number): string {
  const slideIds = Array.from({ length: slideCount }, (_, index) =>
    `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')
  const notesRid = slideCount + 2
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<p:presentation ${A_NS} ${R_NS} ${P_NS} saveSubsetFonts="1">`
    + '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
    + `<p:notesMasterIdLst><p:notesMasterId id="2147483649" r:id="rId${notesRid}"/></p:notesMasterIdLst>`
    + `<p:sldIdLst>${slideIds}</p:sldIdLst>`
    + `<p:sldSz cx="${SLIDE_WEMU}" cy="${SLIDE_HEMU}"/><p:notesSz cx="${SLIDE_HEMU}" cy="9144000"/>`
    + '</p:presentation>'
}

function presentationRelsXml(slideCount: number): string {
  const slides = Array.from({ length: slideCount }, (_, index) =>
    relationshipXml(`rId${index + 2}`, 'officeDocument/2006/relationships/slide', `slides/slide${index + 1}.xml`, false)).join('')
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships ${REL_NS}>`
    + relationshipXml('rId1', 'officeDocument/2006/relationships/slideMaster', 'slideMasters/slideMaster1.xml', false)
    + slides
    + relationshipXml(`rId${slideCount + 2}`, 'officeDocument/2006/relationships/notesMaster', 'notesMasters/notesMaster1.xml', false)
    + '</Relationships>'
}

function corePropsXml(title: string | undefined): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/">'
    + `<dc:title>${encodeXmlText(title ?? 'Presentation')}</dc:title></cp:coreProperties>`
}

const APP_PROPS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">'
  + '<Application>dsh-office-tools</Application><PresentationFormat>Widescreen</PresentationFormat></Properties>'

const ROOT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/officeDocument', 'ppt/presentation.xml', false)
  + relationshipXml('rId2', 'package/2006/relationships/metadata/core-properties', 'docProps/core.xml', false)
  + relationshipXml('rId3', 'officeDocument/2006/relationships/extended-properties', 'docProps/app.xml', false)
  + '</Relationships>'

const MASTER_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml', false)
  + relationshipXml('rId2', 'officeDocument/2006/relationships/theme', '../theme/theme1.xml', false)
  + '</Relationships>'

const LAYOUT_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/slideMaster', '../slideMasters/slideMaster1.xml', false)
  + '</Relationships>'

const NOTES_MASTER_RELS_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + `<Relationships ${REL_NS}>`
  + relationshipXml('rId1', 'officeDocument/2006/relationships/theme', '../theme/theme2.xml', false)
  + '</Relationships>'

function slideRelsXml(index: number, imageTargets: string[], hasNotes: boolean): string {
  const images = imageTargets.map((target, offset) =>
    relationshipXml(`rImg${offset + 1}`, 'officeDocument/2006/relationships/image', target, true)).join('')
  const notes = hasNotes ? relationshipXml('rNotes', 'officeDocument/2006/relationships/notesSlide', `../notesSlides/notesSlide${index}.xml`, false) : ''
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships ${REL_NS}>`
    + relationshipXml('rId1', 'officeDocument/2006/relationships/slideLayout', '../slideLayouts/slideLayout1.xml', false)
    + images + notes
    + '</Relationships>'
}

function notesRelsXml(index: number): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + `<Relationships ${REL_NS}>`
    + relationshipXml('rId1', 'officeDocument/2006/relationships/slide', `../slides/slide${index}.xml`, false)
    + relationshipXml('rId2', 'officeDocument/2006/relationships/notesMaster', '../notesMasters/notesMaster1.xml', false)
    + '</Relationships>'
}

function validateSlideSpecs(slides: SlideSpec[]): void {
  if (slides.length === 0) throw new Error('slides must contain at least one slide')
  if (slides.length > 200) throw new Error('too many slides (maximum 200)')
  for (const [slideIndex, slide] of slides.entries()) {
    const hasContent = (slide.title?.trim().length ?? 0) > 0
      || (slide.paragraphs?.length ?? 0) > 0
      || (slide.bullets?.length ?? 0) > 0
      || (slide.images?.length ?? 0) > 0
    if (!hasContent) throw new Error(`slide ${slideIndex + 1} is empty; give it a title, paragraphs, bullets, or images`)
    if ((slide.paragraphs?.length ?? 0) + (slide.bullets?.length ?? 0) > 500) {
      throw new Error(`slide ${slideIndex + 1} has too many text blocks (maximum 500)`)
    }
    const images = slide.images ?? []
    if (images.length > MAX_IMAGES_PER_SLIDE) {
      throw new Error(`slide ${slideIndex + 1} has too many images (maximum ${MAX_IMAGES_PER_SLIDE})`)
    }
    for (const [imageIndex, image] of images.entries()) {
      for (const key of ['x', 'y', 'w', 'h'] as const) {
        const value = image[key]
        if (value !== undefined && (!Number.isFinite(value) || value <= 0 || value > 100)) {
          throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} ${key} must be a positive number of inches (0-100)`)
        }
      }
      if (image.sizing !== undefined && (image.w === undefined || image.h === undefined)) {
        throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} uses sizing; provide both w and h`)
      }
    }
  }
}

/**
 * Posix-style link target for one image: relative to the deck's directory
 * when the image sits beside or below it (portable within the workspace),
 * otherwise the absolute path with forward slashes.
 */
function imageLinkTarget(deck: ResolvedOfficePath, image: ResolvedOfficePath): string {
  const deckParts = deck.absolute.split('/').filter(Boolean).slice(0, -1)
  const imageParts = image.absolute.split('/').filter(Boolean)
  let common = 0
  while (common < deckParts.length && common < imageParts.length - 1 && deckParts[common] === imageParts[common]) common += 1
  const up = deckParts.length - common
  const relative = [...Array.from({ length: up }, () => '..'), ...imageParts.slice(common)].join('/')
  return relative.startsWith('../') || relative === '' ? image.absolute : relative
}

/**
 * Resolve one slide image: verify the workspace path, sniff intrinsic pixel
 * size, then compute the placed box — explicit w/h wins, a single dimension
 * scales by aspect, and full omission uses natural size. `contain` fits the
 * image inside the box; `cover` keeps the box and crops via srcRect.
 */
async function placeImage(exec: ToolRunContext, ctx: FsContext, deck: ResolvedOfficePath, image: SlideImageSpec, slideIndex: number, imageIndex: number): Promise<PlacedImage> {
  const resolved = await resolveOfficePath(exec, ctx, image.path, IMAGE_EXTENSIONS, true)
  const info = await ctx.fs.stat(resolved.target, exec.signal)
  if (info !== undefined && (info.size ?? 0) > MAX_IMAGE_BYTES) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} "${image.path}" is ${info.size} bytes; maximum linked image size is ${MAX_IMAGE_BYTES} bytes`)
  }
  const head = await ctx.fs.readBytes(resolved.target, exec.signal, 4096)
  const intrinsic = sniffImageSize(head.subarray(0, Math.min(head.byteLength, 1024)))

  const target = imageLinkTarget(deck, resolved)
  const naturalW = intrinsic === undefined ? undefined : (intrinsic.width * EMU_PER_PIXEL) / EMU_PER_INCH
  const naturalH = intrinsic === undefined ? undefined : (intrinsic.height * EMU_PER_PIXEL) / EMU_PER_INCH
  let w = image.w
  let h = image.h
  if ((w === undefined || h === undefined) && naturalW !== undefined && naturalH !== undefined) {
    if (w === undefined && h === undefined) {
      w = naturalW
      h = naturalH
    } else if (w === undefined) {
      // The outer condition guarantees exactly one dimension is missing.
      w = ((h ?? naturalH) / naturalH) * naturalW
    } else {
      h = (w / naturalW) * naturalH
    }
  }
  if (w === undefined || h === undefined) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} "${image.path}" is not a recognizable PNG/JPEG/GIF (no intrinsic size); provide explicit w and h in inches`)
  }
  if (w <= 0 || h <= 0) {
    throw new Error(`slide ${slideIndex + 1} image ${imageIndex + 1} resolves to a non-positive size`)
  }

  const placed: PlacedImage = {
    type: 'image',
    xIn: 0, yIn: 0, wIn: Math.round(w * 100) / 100, hIn: Math.round(h * 100) / 100,
    alt: image.alt ?? image.path,
    path: target,
    sizing: image.sizing,
    target,
    pixelWidth: intrinsic?.width,
    pixelHeight: intrinsic?.height,
  }

  if (image.sizing === 'contain' || image.sizing === 'cover') {
    const boxAspect = w / h
    const imageAspect = naturalW !== undefined && naturalH !== undefined && naturalH !== 0 ? naturalW / naturalH : boxAspect
    if (image.sizing === 'contain') {
      // Fit whole inside the box: the tighter constraint wins.
      const containedW = Math.min(w, h * imageAspect)
      const containedH = Math.min(h, w / imageAspect)
      placed.wIn = Math.round(containedW * 100) / 100
      placed.hIn = Math.round(containedH * 100) / 100
    } else if (imageAspect > boxAspect && imageAspect > 0) {
      // Image wider than the box: crop left/right so the box aspect is covered.
      const visible = Math.round(((boxAspect / imageAspect) * 100000) / 2)
      placed.crop = { l: visible, t: 0, r: visible, b: 0 }
    } else if (imageAspect > 0) {
      const visible = Math.round(((imageAspect / boxAspect) * 100000) / 2)
      placed.crop = { l: 0, t: visible, r: 0, b: visible }
    }
  }
  return placed
}

interface SlideBuild {
  spec: SlideSpec
  first: boolean
  images: PlacedImage[]
}

/** Shapes + element echo for one slide, mirroring the pptxgenjs-era layout math. */
function slideParts(build: SlideBuild): { xml: string; elements: SlideElementBox[] } {
  const { spec, first } = build
  const shapes: string[] = []
  const elements: SlideElementBox[] = []
  const hasTitle = spec.title !== undefined && spec.title.trim() !== ''
  let id = 2

  if (first && hasTitle) {
    const part = textBoxPart(id++, 0.9, 1.2, 11.53, 1.2, 32, [spec.title!], true, true)
    shapes.push(part.xml)
    elements.push(part.box)
  } else if (hasTitle) {
    const part = textBoxPart(id++, 0.9, 0.35, 11.53, 0.9, 26, [spec.title!], true, false)
    shapes.push(part.xml)
    elements.push(part.box)
  }

  const top = first && hasTitle ? 2.7 : hasTitle ? 1.5 : 0.8
  let y = top

  if ((spec.paragraphs?.length ?? 0) > 0) {
    for (const paragraph of spec.paragraphs!) {
      if (y > 6.4) break
      const part = textBoxPart(id++, 0.9, y, 11.53, 0.7, 18, [paragraph], false, false)
      shapes.push(part.xml)
      elements.push(part.box)
      y += 0.8
    }
    y += 0.2
  }

  if ((spec.bullets?.length ?? 0) > 0) {
    const height = Math.min(4.5, Math.max(1, spec.bullets!.length * 0.6))
    const part = bulletBoxPart(id++, 0.9, y, 11.53, height, spec.bullets!)
    shapes.push(part.xml)
    elements.push(part.box)
  }

  const images = build.images
  if (images.length > 0) {
    const explicitAt = (index: number) => {
      const explicit = build.spec.images?.[index]
      return explicit !== undefined
        && (explicit.x !== undefined || explicit.y !== undefined)
    }
    const automaticCount = images.filter((_, index) => !explicitAt(index)).length
    const automaticHeight = Math.max(0.6, Math.min(3.2, (6.6 - Math.min(y, 6.4)) / Math.max(1, automaticCount)))
    let imageY = Math.min(y + 0.25, 6.5)
    images.forEach((image, imageIndex) => {
      const explicit = build.spec.images?.[imageIndex]
      if (explicitAt(imageIndex)) {
        image.xIn = explicit?.x ?? 0
        image.yIn = explicit?.y ?? 0
      } else {
        image.xIn = 0.9
        image.yIn = Math.round(imageY * 100) / 100
        if (explicit?.w === undefined && explicit?.h === undefined) {
          image.wIn = Math.round(11.53 * 100) / 100
          image.hIn = Math.round(automaticHeight * 100) / 100
        }
        imageY += image.hIn + 0.15
      }
      shapes.push(linkedPicturePart(id++, image, `rImg${imageIndex + 1}`))
      const { target: _target, pixelWidth: _w, pixelHeight: _h, crop: _c, ...box } = image
      elements.push({ ...box, sizing: image.sizing ?? (explicit?.sizing ?? 'contain') })
    })
  }

  return { xml: shapes.join(''), elements }
}

/** Build the whole deck as an ASCII-safe package plus the layout echo. */
export async function buildPptxText(
  args: PptCreateArgs,
  exec: ToolRunContext,
  ctx: FsContext,
  deck: ResolvedOfficePath,
): Promise<{ text: string; layout: Array<{ index: number; elements: SlideElementBox[] }> }> {
  const builds: SlideBuild[] = []
  if (args.title !== undefined && args.title.trim() !== '') {
    builds.push({ spec: { title: args.title }, first: true, images: [] })
  }
  const slides = args.slides ?? []
  let first = args.title === undefined || args.title.trim() === ''
  for (const spec of slides) {
    builds.push({ spec, first, images: [] })
    first = false
  }
  const slideCount = builds.length
  if (slideCount === 0) throw new Error('ppt_create needs a title or at least one slide')

  for (const [slideIndex, build] of builds.entries()) {
    const images = build.spec.images ?? []
    build.images = []
    for (const [imageIndex, image] of images.entries()) {
      build.images.push(await placeImage(exec, ctx, deck, image, slideIndex, imageIndex))
    }
  }

  const notesCount = builds.filter(build => build.spec.notes !== undefined && build.spec.notes.trim() !== '').length
  const layout: Array<{ index: number; elements: SlideElementBox[] }> = []
  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', content: contentTypesXml(slideCount, notesCount) },
    { name: '_rels/.rels', content: ROOT_RELS_XML },
    { name: 'ppt/presentation.xml', content: presentationXml(slideCount) },
    { name: 'ppt/_rels/presentation.xml.rels', content: presentationRelsXml(slideCount) },
    { name: 'ppt/slideMasters/slideMaster1.xml', content: SLIDE_MASTER_XML },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', content: MASTER_RELS_XML },
    { name: 'ppt/slideLayouts/slideLayout1.xml', content: SLIDE_LAYOUT_XML },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', content: LAYOUT_RELS_XML },
    { name: 'ppt/notesMasters/notesMaster1.xml', content: NOTES_MASTER_XML },
    { name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', content: NOTES_MASTER_RELS_XML },
    { name: 'ppt/theme/theme1.xml', content: THEME_XML },
    { name: 'ppt/theme/theme2.xml', content: THEME_XML },
    { name: 'docProps/core.xml', content: corePropsXml(args.title) },
    { name: 'docProps/app.xml', content: APP_PROPS_XML },
  ]
  builds.forEach((build, index) => {
    const number = index + 1
    const { xml, elements } = slideParts(build)
    layout.push({ index: number, elements })
    const hasNotes = build.spec.notes !== undefined && build.spec.notes.trim() !== ''
    parts.push({ name: `ppt/slides/slide${number}.xml`, content: slideXml(xml) })
    parts.push({
      name: `ppt/slides/_rels/slide${number}.xml.rels`,
      content: slideRelsXml(number, build.images.map(image => image.target), hasNotes),
    })
    if (hasNotes) {
      parts.push({ name: `ppt/notesSlides/notesSlide${number}.xml`, content: notesSlideXml(build.spec.notes!) })
      parts.push({ name: `ppt/notesSlides/_rels/notesSlide${number}.xml.rels`, content: notesRelsXml(number) })
    }
  })
  return { text: buildAsciiZip(parts), layout }
}

// ---------------------------------------------------------------------------
// Wireframe sketch — the model's "eyes" for the composition
// ---------------------------------------------------------------------------

/** Render one slide as an ASCII wireframe: the canvas frame plus boxes. */
export function sketchSlide(widthIn: number, heightIn: number, elements: Array<Pick<SlideElementBox, 'type' | 'xIn' | 'yIn' | 'wIn' | 'hIn' | 'text'>>): string {
  const columns = 64
  const rows = 18
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '))
  const scaleX = columns / widthIn
  const scaleY = rows / heightIn

  const drawRect = (x: number, y: number, w: number, h: number, label: string) => {
    const left = Math.max(1, Math.min(columns - 2, Math.round(x * scaleX)))
    const right = Math.max(left + 1, Math.min(columns - 2, Math.round((x + w) * scaleX)))
    const topRow = Math.max(1, Math.min(rows - 2, Math.round(y * scaleY)))
    const bottom = Math.max(topRow + 1, Math.min(rows - 2, Math.round((y + h) * scaleY)))
    for (let column = left; column <= right; column += 1) {
      grid[topRow]![column]! = '-'
      grid[bottom]![column]! = '-'
    }
    for (let row = topRow; row <= bottom; row += 1) {
      grid[row]![left]! = '|'
      grid[row]![right]! = '|'
    }
    grid[topRow]![left]! = '+'
    grid[topRow]![right]! = '+'
    grid[bottom]![left]! = '+'
    grid[bottom]![right]! = '+'
    const inner = right - left - 1
    if (inner > 2 && bottom - topRow >= 2) {
      const text = label.slice(0, Math.min(label.length, inner))
      for (let offset = 0; offset < text.length; offset += 1) {
        grid[topRow + 1]![left + 1 + Math.floor((inner - text.length) / 2) + offset]! = text[offset]!
      }
    }
  }

  for (const element of elements) {
    const label = element.type === 'image' ? 'IMG' : (element.text ?? element.type).split(/\s+/)[0]?.slice(0, 10) || element.type
    drawRect(element.xIn, element.yIn, element.wIn, element.hIn, label)
  }

  const border: string[] = []
  border.push('+' + '-'.repeat(columns) + '+')
  for (const row of grid) border.push('|' + row.join('') + '|')
  border.push('+' + '-'.repeat(columns) + '+')
  return border.join('\n')
}

// ---------------------------------------------------------------------------
// Reader (extraction contract unchanged, plus element geometry)
// ---------------------------------------------------------------------------

/** Extract one `<a:p>` paragraph as a plain-text string. */
function paragraphText(paragraphXml: string): string {
  const runs: string[] = []
  const runPattern = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g
  for (const match of paragraphXml.matchAll(runPattern)) runs.push(match[1] ?? '')
  const text = decodeXmlEntities(runs.join('').replace(/<a:br\b[^>]*\/>/g, '\n'))
  return text
}

/**
 * Split slide/notes XML into paragraph strings. `skipFields` drops
 * auto-generated field paragraphs (slide-number placeholders), which carry no
 * author content and would otherwise surface as stray digits in `ppt_read`.
 */
function extractParagraphs(xml: string, skipFields: boolean): string[] {
  const paragraphs: string[] = []
  const pattern = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g
  for (const match of xml.matchAll(pattern)) {
    const paragraph = match[1] ?? ''
    if (skipFields && /<a:fld\b/.test(paragraph)) continue
    const text = paragraphText(paragraph)
    if (text.trim() !== '') paragraphs.push(text)
  }
  return paragraphs
}

const A_TABLE = /<a:tbl\b[\s\S]*?<\/a:tbl>/g
const A_TABLE_ROW = /<a:tr\b[\s\S]*?<\/a:tr>/g
const A_TABLE_CELL = /<a:tc\b[\s\S]*?<\/a:tc>/g
const PICTURE = /<p:pic\b[\s\S]*?<\/p:pic>/g
const PICTURE_DESCR = /<p:cNvPr\b[^>]*\bdescr="([^"]*)"/
const SHAPE_WITH_GEOMETRY = /<p:sp\b[\s\S]*?<\/p:sp>|<p:pic\b[\s\S]*?<\/p:pic>|<p:graphicFrame\b[\s\S]*?<\/p:graphicFrame>/g
const GEOMETRY = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/

/** One slide's tables as rows of cell texts (cell paragraphs joined with spaces). */
function extractTables(slideXmlText: string): string[][][] {
  const tables: string[][][] = []
  for (const tableMatch of slideXmlText.matchAll(A_TABLE)) {
    const rows = [...(tableMatch[0] ?? '').matchAll(A_TABLE_ROW)].map(rowMatch =>
      [...(rowMatch[0] ?? '').matchAll(A_TABLE_CELL)].map(cellMatch =>
        extractParagraphs(cellMatch[0] ?? '', false).join(' ')))
    if (rows.length > 0) tables.push(rows)
  }
  return tables
}

/** Remove table blocks so their cell paragraphs do not also surface as plain paragraphs. */
function stripTables(slideXmlText: string): string {
  return slideXmlText.replace(A_TABLE, '')
}

/** Alt texts (descr) of a slide's pictures in document order; empty ones dropped. */
function extractImageAlts(slideXmlText: string): string[] {
  const alts: string[] = []
  for (const pictureMatch of slideXmlText.matchAll(PICTURE)) {
    const descrMatch = (pictureMatch[0] ?? '').match(PICTURE_DESCR)
    const descr = descrMatch === null ? undefined : descrMatch[1]
    if (descr !== undefined && descr.trim() !== '') alts.push(decodeXmlEntities(descr))
  }
  return alts
}

/**
 * Every placed shape of one slide with its bounding box in inches, in
 * document (z) order: text/picture/table boxes with a short text payload.
 */
function extractElements(slideXmlText: string): SlideElementBox[] {
  const elements: SlideElementBox[] = []
  for (const match of slideXmlText.matchAll(SHAPE_WITH_GEOMETRY)) {
    const block = match[0] ?? ''
    const geometry = (block).match(GEOMETRY)
    const base = geometry === null
      ? { xIn: 0, yIn: 0, wIn: 0, hIn: 0 }
      : {
          xIn: roundedInches(Number(geometry[1])),
          yIn: roundedInches(Number(geometry[2])),
          wIn: roundedInches(Number(geometry[3])),
          hIn: roundedInches(Number(geometry[4])),
        }
    if (block.startsWith('<p:pic')) {
      const descr = (block).match(PICTURE_DESCR)?.[1]
      elements.push({ type: 'image', ...base, alt: descr === undefined ? undefined : decodeXmlEntities(descr) })
      continue
    }
    if (block.startsWith('<p:graphicFrame')) {
      const table = extractTables(block)[0]
      elements.push({
        type: 'table', ...base,
        text: table === undefined ? undefined : `${table.length}x${table[0]?.length ?? 0}`,
      })
      continue
    }
    const text = extractParagraphs(stripTables(block), false).join(' | ')
    elements.push({ type: 'text', ...base, text: text.length > 120 ? `${text.slice(0, 117)}...` : text })
  }
  return elements
}

function decodeRelationshipTarget(xml: string): string | undefined {
  const match = xml.match(/Target="([^"]*notesSlides\/notesSlide(\d+)\.xml)"/)
  if (match === null) return undefined
  return `ppt/notesSlides/notesSlide${match[2]}.xml`
}

function slideNumber(name: string): number {
  const match = name.match(/slide(\d+)\.xml$/)
  return match === null ? 0 : Number.parseInt(match[1]!, 10)
}

/** Count image relationships on one slide. */
function countSlideImages(zip: ReturnType<typeof readZip>, number: number): number {
  const xml = readZipXmlPart(zip, `ppt/slides/_rels/slide${number}.xml.rels`)
  if (xml === null) return 0
  return [...xml.matchAll(/Type="[^"]*\/image"/g)].length
}

interface SlideReadData {
  xmls: string[]
  notes: Array<string | undefined>
  imageCounts: number[]
  widthInches: number
  heightInches: number
}

function readSlideXml(zip: ReturnType<typeof readZip>): SlideReadData {
  const slideFiles = zip.entryNames()
    .filter(name => /^ppt\/slides\/slide[0-9]+\.xml$/.test(name))
    .sort((left, right) => slideNumber(left) - slideNumber(right))
  const xmls = slideFiles.map(name => readZipXmlPart(zip, name) ?? '')

  const presentation = readZipXmlPart(zip, 'ppt/presentation.xml')
  const size = (presentation ?? '').match(/<p:sldSz cx="(\d+)" cy="(\d+)"\/>/)
  const widthInches = size === null ? SLIDE_WIDTH_INCHES : roundedInches(Number(size[1]))
  const heightInches = size === null ? SLIDE_HEIGHT_INCHES : roundedInches(Number(size[2]))

  const notes = xmls.map((_, index) => {
    const number = slideNumber(slideFiles[index]!) || index + 1
    const relationship = readZipXmlPart(zip, `ppt/slides/_rels/slide${number}.xml.rels`)
    let notesName = `ppt/notesSlides/notesSlide${number}.xml`
    if (relationship !== null) {
      const target = decodeRelationshipTarget(relationship)
      if (target !== undefined) notesName = target
    }
    const noteFile = readZipXmlPart(zip, notesName)
    if (noteFile === null) return undefined
    const paragraphs = extractParagraphs(noteFile, true)
    return paragraphs.length === 0 ? undefined : paragraphs.join('\n')
  })

  const imageCounts = xmls.map((_, index) => {
    const number = slideNumber(slideFiles[index]!) || index + 1
    return countSlideImages(zip, number)
  })
  return { xmls, notes, imageCounts, widthInches, heightInches }
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const ELEMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', required: true, description: 'Element kind: text, bullets, image, or table.' },
    xIn: { type: 'number', required: true, description: 'Left edge in inches from the slide origin.' },
    yIn: { type: 'number', required: true, description: 'Top edge in inches from the slide origin.' },
    wIn: { type: 'number', required: true, description: 'Width in inches.' },
    hIn: { type: 'number', required: true, description: 'Height in inches.' },
    text: { type: 'string', description: 'Text content (short); tables report rows x columns.' },
    items: { type: 'array', items: { type: 'string' }, description: 'Bullet items, for bullets boxes this plugin wrote.' },
    alt: { type: 'string', description: 'Image alt text.' },
    path: { type: 'string', description: 'Linked image target path, when the writer placed it.' },
    sizing: { type: 'string', enum: ['contain', 'cover'], description: 'Fit mode used for the placement.' },
  },
} as const

const SLIDE_LAYOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    elements: { type: 'array', required: true, items: ELEMENT_SCHEMA },
  },
} as const

const SLIDE_SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    title: { type: 'string' },
    paragraphs: {
      type: 'array',
      required: true,
      items: { type: 'string' },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
    },
    tables: {
      type: 'array',
      items: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      description: 'Tables as rows of cell texts (paragraphs joined with spaces); present only when the slide has tables.',
    },
    imageAlts: {
      type: 'array',
      items: { type: 'string' },
      description: 'Alt text (descr) of the slide\'s pictures in order; present only when at least one is non-empty.',
    },
    imageCount: { type: 'integer', required: true },
    elements: {
      type: 'array',
      items: ELEMENT_SCHEMA,
      description: 'Every placed shape with its bounding box in inches, in z-order.',
    },
  },
} as const

const PPT_CREATE_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FILE_RESULT_SCHEMA.properties,
    title: { type: 'string' },
    slideCount: { type: 'integer', required: true },
    slideWidthInches: { type: 'number', required: true, description: 'Canvas width (13.33 in widescreen).' },
    slideHeightInches: { type: 'number', required: true, description: 'Canvas height (7.5 in widescreen).' },
    slides: {
      type: 'array',
      required: true,
      items: SLIDE_LAYOUT_SCHEMA,
      description: 'Per-slide element layout echo: where every text box, bullet list, and linked image landed, in inches.',
    },
  },
} as const

const PPT_READ_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    slideCount: { type: 'integer', required: true },
    slideWidthInches: { type: 'number', required: true },
    slideHeightInches: { type: 'number', required: true },
    slides: {
      type: 'array',
      required: true,
      items: SLIDE_SUMMARY_SCHEMA,
    },
    truncated: { type: 'boolean', required: true },
    sizeBytes: { type: 'integer', required: true },
  },
} as const

function registerPptCreate(ctx: Context & FsContext): () => void {
  return ctx.tools.register(defineTool({
    name: 'ppt_create',
    description:
      'Create a PowerPoint .pptx presentation in the session workspace (16:9 widescreen, 13.33 x 7.5 in). '
      + 'Optionally start with a title slide, then add slides with a title, body paragraphs, bullet points, speaker notes, and linked PNG/JPG/GIF images. '
      + 'Images are linked, not embedded: give x/y/w/h in inches for explicit placement (sizing: contain fits inside the box, cover fills it and crops), or omit them for automatic placement below the text at natural size. '
      + 'The result echoes every element\'s landing position (inches) and a text wireframe sketch of each slide, so you can verify the composition you authored.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Output path. Relative paths resolve against the session workspace; the extension must be .pptx.',
      },
      title: {
        type: 'string',
        description: 'Deck title. When provided, a title slide is inserted before the explicit slides.',
      },
      slides: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', description: 'Slide title.' },
            paragraphs: {
              type: 'array',
              items: { type: 'string' },
              description: 'Body paragraphs rendered as plain text boxes.',
            },
            bullets: {
              type: 'array',
              items: { type: 'string' },
              description: 'Bullet list items rendered after the paragraphs.',
            },
            notes: { type: 'string', description: 'Speaker notes for this slide.' },
            images: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  path: {
                    type: 'string',
                    required: true,
                    description: 'Image file inside the session workspace: .png, .jpg, .jpeg, or .gif. The deck links to it, so keep the file in place.',
                  },
                  x: { type: 'number', description: 'Left position in inches on the 13.33x7.5 slide. Omit for automatic placement below the text.' },
                  y: { type: 'number', description: 'Top position in inches. Omit for automatic placement.' },
                  w: { type: 'number', description: 'Display width in inches. Omit to use the intrinsic size (PNG/JPG/GIF headers are sniffed).' },
                  h: { type: 'number', description: 'Display height in inches. Omit to use the intrinsic size; a single dimension scales by aspect.' },
                  sizing: {
                    type: 'string',
                    enum: ['contain', 'cover'],
                    description: 'Fit mode inside the w x h box: contain fits whole (default), cover fills and crops. Requires w and h.',
                  },
                  alt: { type: 'string', description: 'Alt text; defaults to the image path.' },
                },
              },
              description: 'Images linked on this slide, drawn after the text content.',
            },
          },
        },
        description: 'Slides in presentation order. Optional when a title is provided.',
      },
      overwrite: {
        type: 'boolean',
        description: 'Replace the file when it already exists. Defaults to false.',
      },
    },
    output: {
      schema: PPT_CREATE_OUTPUT,
      render: (_args, value: any) => [{
        type: 'text',
        text: `Created PowerPoint ${value.path} (${value.sizeBytes} bytes; ${value.slideCount} slide(s), canvas ${value.slideWidthInches}x${value.slideHeightInches} in).\n`
          + value.slides.map((slide: any) => `Slide ${slide.index} layout:\n${sketchSlide(value.slideWidthInches, value.slideHeightInches, slide.elements)}`).join('\n\n'),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Create ${args.path}`,
      kind: 'edit',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec: ToolRunContext) {
      const target = await resolveOfficePath(exec, ctx, args.path, ['.pptx'], false)
      await assertMayCreate(exec, ctx, target.target, args.overwrite ?? false)
      if ((args.slides?.length ?? 0) > 0) validateSlideSpecs(args.slides!)
      if (args.title === undefined && (args.slides?.length ?? 0) === 0) {
        throw new Error('ppt_create needs a title or at least one slide')
      }
      exec.signal.throwIfAborted()

      const { text, layout } = await buildPptxText(args, exec, ctx, target)
      exec.signal.throwIfAborted()
      const sizeBytes = await saveOfficeText(exec, ctx, target.target, text)
      const result: {
        path: string
        sizeBytes: number
        title?: string
        slideCount: number
        slideWidthInches: number
        slideHeightInches: number
        slides: Array<{ index: number; elements: SlideElementBox[] }>
      } = {
        path: target.display,
        sizeBytes,
        slideCount: layout.length,
        slideWidthInches: Math.round(SLIDE_WIDTH_INCHES * 100) / 100,
        slideHeightInches: SLIDE_HEIGHT_INCHES,
        slides: layout,
      }
      if (args.title !== undefined && args.title.trim() !== '') result.title = args.title
      return result
    },
  }))
}

function registerPptRead(ctx: Context & FsContext): () => void {
  return ctx.tools.register(defineTool({
    name: 'ppt_read',
    description:
      'Extract the content and layout of an existing .pptx presentation. Per slide, in slide order: paragraphs, tables (rows of cell texts), speaker notes, linked/embedded image count, image alt texts — plus an `elements` array giving every shape\'s bounding box in inches (x/y/w/h) and the deck canvas size, with a text wireframe sketch of each slide. '
      + 'Table cell text is reported under `tables`, not duplicated into `paragraphs`. '
      + 'Use it to understand, summarize, or re-layout a deck: the element boxes tell you exactly where everything sits on the canvas.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the .pptx file, relative to the session workspace or absolute inside it.',
      },
      max_chars: {
        type: 'integer',
        description: `Maximum characters returned across the deck. Defaults to ${MAX_TEXT_CHARS}.`,
      },
    },
    output: {
      schema: PPT_READ_OUTPUT,
      render: (_args, value: any) => [{
        type: 'text',
        text: `Canvas ${value.slideWidthInches}x${value.slideHeightInches} in.\n`
          + value.slides.map((slide: any) =>
            `Slide ${slide.index}${slide.title !== undefined ? ` — ${slide.title}` : ''} (images: ${slide.imageCount}${slide.imageAlts !== undefined ? `; alts: ${slide.imageAlts.join(' | ')}` : ''}):\n`
            + slide.paragraphs.map((paragraph: string) => `- ${paragraph}`).join('\n')
            + (slide.tables !== undefined ? `\nTables:\n${slide.tables.map((table: string[][]) => table.map((row: string[]) => row.join(' | ')).join('\n')).join('\n\n')}` : '')
            + (slide.notes !== undefined ? `\nNotes: ${slide.notes.join(' | ')}` : '')
            + (slide.elements !== undefined && slide.elements.length > 0 ? `\n${sketchSlide(value.slideWidthInches, value.slideHeightInches, slide.elements)}` : ''),
          ).join('\n\n') + (value.truncated ? '\n[text truncated]' : ''),
      }],
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Read ${args.path}`,
      kind: 'read',
      locations: [{ path: args.path }],
    }),
    async execute(args, exec: ToolRunContext) {
      const target = await resolveOfficePath(exec, ctx, args.path, ['.pptx'], true)
      const { bytes, sizeBytes } = await readOfficeBytes(exec, ctx, target.target)
      const zip = readZip(bytes)
      const { xmls, notes, imageCounts, widthInches, heightInches } = readSlideXml(zip)
      if (xmls.length === 0) throw new Error('the .pptx contains no slides')

      const maxChars = Math.min(Math.max(args.max_chars ?? MAX_TEXT_CHARS, 1), MAX_TEXT_CHARS)
      const slides: Array<{
        index: number
        title?: string
        paragraphs: string[]
        notes?: string[]
        tables?: string[][][]
        imageAlts?: string[]
        imageCount: number
        elements: SlideElementBox[]
      }> = []
      let totalChars = 0
      let truncated = false

      for (let index = 0; index < xmls.length; index += 1) {
        const slideXmlText = xmls[index]!
        const paragraphs = extractParagraphs(stripTables(slideXmlText), false)
        const tables = extractTables(slideXmlText)
        const imageAlts = extractImageAlts(slideXmlText)
        const elements = extractElements(slideXmlText)
        const noteText = notes[index]
        const noteParagraphs = noteText === undefined || noteText.trim() === '' ? undefined : [noteText]
        const body = paragraphs
        const remainingChars = Math.max(0, maxChars - totalChars)
        let slideChars = 0
        const bounded = body.map((paragraph) => {
          if (slideChars >= remainingChars) return ''
          const retained = paragraph.slice(0, remainingChars - slideChars)
          slideChars += retained.length
          return retained
        })
        const noteBounded = noteParagraphs === undefined ? undefined : [noteParagraphs[0]!.slice(0, Math.max(0, remainingChars - slideChars))]
        const bodyChars = body.reduce((sum, paragraph) => sum + paragraph.length, 0)
        const noteChars = noteParagraphs?.[0]?.length ?? 0
        totalChars += slideChars + (noteBounded?.[0]?.length ?? 0)
        if (bodyChars + noteChars > slideChars + (noteBounded?.[0]?.length ?? 0)) truncated = true
        // Tables share the deck budget whole: they are included while they
        // fit, otherwise dropped with the truncated flag set.
        const tablesChars = tables.reduce((sum, table) => sum + table.reduce((rowSum, row) => rowSum + row.join('').length, 0), 0)
        const tablesFit = totalChars + tablesChars <= maxChars
        if (!tablesFit && tables.length > 0) truncated = true
        const slide: {
          index: number
          title?: string
          paragraphs: string[]
          notes?: string[]
          tables?: string[][][]
          imageAlts?: string[]
          imageCount: number
          elements: SlideElementBox[]
        } = {
          index: index + 1,
          paragraphs: bounded.filter(paragraph => paragraph !== ''),
          imageCount: imageCounts[index] ?? 0,
          elements,
        }
        if (noteBounded !== undefined) slide.notes = noteBounded
        if (tablesFit && tables.length > 0) {
          slide.tables = tables
          totalChars += tablesChars
        }
        if (imageAlts.length > 0) slide.imageAlts = imageAlts
        slides.push(slide)
      }

      return {
        path: target.display,
        slideCount: slides.length,
        slideWidthInches: widthInches,
        slideHeightInches: heightInches,
        slides,
        truncated,
        sizeBytes,
      }
    },
  }))
}

export function registerPptTools(ctx: Context & FsContext): () => void {
  const disposers = [registerPptCreate(ctx), registerPptRead(ctx)]
  return () => disposers.forEach(dispose => dispose())
}
