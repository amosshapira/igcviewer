//go:build flugbuech

/*

	This file contains the flugbuech integration, compiled in using the
	"flugbuech" build tag (go build -tags flugbuech).

	Copyright (C) 2026  Michael Ablassmeier <abi@grinser.de>

	This program is free software: you can redistribute it and/or modify
	it under the terms of the GNU Affero General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	This program is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU Affero General Public License for more details.

	You should have received a copy of the GNU Affero General Public License
	along with this program.  If not, see <https://www.gnu.org/licenses/>.

*
*/

package main

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"igcp/internal/igc"
)

// Client used for fetching flights from the flugbuech API.
var fetchClient = &http.Client{Timeout: 60 * time.Second}

func handleFlight(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		handleFlightUpload(w, r)
	case http.MethodGet:
		handleFlightFetch(w, r)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleFlightFetch downloads the IGC file of a flight from the flugbuech
// instance configured using the IGCVIEWER_UPSTREAM environment variable and
// parses it.
//
// The flight ID is passed using the "flight" query parameter. Authentication
// against the flugbuech API happens using the access token configured using
// the IGCVIEWER_TOKEN environment variable.
func handleFlightFetch(w http.ResponseWriter, r *http.Request) {
	flightID := strings.TrimSpace(r.URL.Query().Get("flight"))
	if flightID == "" {
		http.Error(w, "missing query parameter 'flight'", http.StatusBadRequest)
		return
	}
	if !isDigits(flightID) {
		http.Error(w, "invalid flight id", http.StatusBadRequest)
		return
	}

	upstream := strings.TrimRight(os.Getenv("IGCVIEWER_UPSTREAM"), "/")
	token := os.Getenv("IGCVIEWER_TOKEN")
	if upstream == "" || token == "" {
		http.Error(w, "no flugbuech upstream configured", http.StatusNotFound)
		return
	}

	fetchURL := fmt.Sprintf(
		"%s/api/v1/flights/%s/igc?t=%s",
		upstream,
		url.PathEscape(flightID),
		url.QueryEscape(token),
	)
	req, err := http.NewRequestWithContext(r.Context(), http.MethodGet, fetchURL, nil)
	if err != nil {
		http.Error(w, "could not create request", http.StatusInternalServerError)
		return
	}

	res, err := fetchClient.Do(req)
	if err != nil {
		log.Printf("Fetching flight %s failed: %v", flightID, err)
		http.Error(w, "could not fetch flight", http.StatusBadGateway)
		return
	}
	defer res.Body.Close()

	switch {
	case res.StatusCode == http.StatusNotFound:
		http.Error(w, "flight not found", http.StatusNotFound)
		return
	case res.StatusCode != http.StatusOK:
		http.Error(w, "unexpected response from flugbuech API", http.StatusBadGateway)
		return
	}

	data, err := io.ReadAll(http.MaxBytesReader(w, res.Body, maxUploadSize))
	if err != nil {
		http.Error(w, "could not read flight data", http.StatusBadGateway)
		return
	}

	flight, err := igc.Parse(bytes.NewReader(data))
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	name := fmt.Sprintf("flight%s.igc", flightID)
	resp, err := buildResponse(name, flight)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	writeJSON(w, resp)
}

func isDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(s) > 0
}
