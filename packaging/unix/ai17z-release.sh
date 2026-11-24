# shellcheck shell=bash
# Shared release selection for bootstraps and installed updaters.
ai17z_pick_tag() { # json template [explicit tag]
  # Read release objects and asset names together, then apply semver precedence.
  # awk is present on both supported Unix platforms, including a fresh Mac.
  printf '%s' "$1" | LC_ALL=C awk -v template="$2" -v requested="${3:-}" '
    function numeric(a, b) {
      sub(/^0+/, "", a); sub(/^0+/, "", b)
      if (length(a) != length(b)) return length(a) > length(b) ? 1 : -1
      return ("x" a) == ("x" b) ? 0 : (("x" a) > ("x" b) ? 1 : -1)
    }
    function newer(a, b,    ac,bc,ap,bp,an,bn,i,c,x,y,na,nb) {
      sub(/^v/, "", a); sub(/^v/, "", b); sub(/\+.*/, "", a); sub(/\+.*/, "", b)
      i=index(a,"-"); ac=i ? substr(a,1,i-1) : a; ap=i ? substr(a,i+1) : ""
      i=index(b,"-"); bc=i ? substr(b,1,i-1) : b; bp=i ? substr(b,i+1) : ""
      split(ac,x,"."); split(bc,y,".")
      for(i=1;i<=3;i++) { c=numeric(x[i],y[i]); if(c) return c>0 }
      if(ap=="" || bp=="") return ap=="" && bp!=""
      an=split(ap,x,"."); bn=split(bp,y,".")
      for(i=1;i<=an && i<=bn;i++) {
        na=x[i] ~ /^[0-9]+$/; nb=y[i] ~ /^[0-9]+$/
        if(na != nb) return !na
        c=na ? numeric(x[i],y[i]) : (("x" x[i]) == ("x" y[i]) ? 0 : (("x" x[i]) > ("x" y[i]) ? 1 : -1))
        if(c) return c>0
      }
      return an>bn
    }
    function consider(    version,wanted) {
      if(draft || tag !~ /^v?[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/) return
      if(requested!="" && tag!=requested) return
      version=tag; sub(/^v/, "", version); wanted=template
      sub(/<version>/, version, wanted)
      if(requested=="" && template!="" && !(wanted in names)) return
      if(best=="" || newer(tag,best)) best=tag
    }
    {
      for(pos=1;pos<=length($0);pos++) {
        ch=substr($0,pos,1)
        if(quoted) {
          if(escaped) { token=token "\\" ch; escaped=0; continue }
          if(ch=="\\") { escaped=1; continue }
          if(ch=="\"") {
            quoted=0
            if(key=="tag_name" && depth==releaseDepth) tag=token
            if(key=="name" && assetsDepth && depth==assetsDepth+1) names[token]=1
            last=token; key=""
          } else token=token ch
          continue
        }
        if(ch=="\"") { quoted=1; token=""; continue }
        if(ch==":") { key=last; bare=""; continue }
        if(ch=="{" || ch=="[") {
          depth++
          if(ch=="{" && !releaseDepth) { releaseDepth=depth; tag=""; draft=0; delete names }
          if(ch=="[" && key=="assets" && depth==releaseDepth+1) assetsDepth=depth
          key=""; bare=""; continue
        }
        if(ch=="," || ch=="}" || ch=="]") {
          if(key=="draft" && depth==releaseDepth && bare ~ /true/) draft=1
          if(ch=="}" && depth==releaseDepth) { consider(); releaseDepth=0 }
          if(ch=="]" && depth==assetsDepth) assetsDepth=0
          if(ch!=",") depth--
          key=""; bare=""; continue
        }
        bare=bare ch
      }
    }
    END { if(best!="") print best }
  '
}
