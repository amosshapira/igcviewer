//go:build !flugbuech

/*

	This file is compiled when the "flugbuech" build tag is not set: only
	the regular file upload API is available.

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

import "net/http"

func handleFlight(w http.ResponseWriter, r *http.Request) {
	handleFlightUpload(w, r)
}
