-- atlas:// URL scheme handler.
-- Receives clicks on atlas://… links (from terminal OSC 8, Spotlight, etc.)
-- and re-routes them to Google Chrome. The atlas:// scheme is just a marker
-- that means "open in Chrome regardless of the system default browser".

on open location this_URL
    set urlStr to this_URL as string
    if urlStr starts with "atlas://" then
        -- atlas://host/path → http://host/path
        set httpUrl to "http://" & (text 9 thru -1 of urlStr)
    else if urlStr starts with "atlass://" then
        -- Reserved for future TLS-secured Atlas (atlass:// → https://)
        set httpUrl to "https://" & (text 10 thru -1 of urlStr)
    else
        set httpUrl to urlStr
    end if
    do shell script "open -a 'Google Chrome' " & quoted form of httpUrl
end open location
