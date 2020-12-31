#!/bin/bash

cd /tmp
mkdir SEQ_GTFS
cd SEQ_GTFS
wget https://gtfsrt.api.translink.com.au/GTFS/SEQ_GTFS.zip
unzip SEQ_GTFS.zip
mysql --local-infile=1 -u translink_gtfs -p translink_gtfs < {path-to-repo}/db/scripts}/5\ import\ data.sql
mysql -u translink_gtfs -p translink_gtfs < {path-to-repo}/db/scripts/6\ create\ indexes.sql
cd ..
rm -rf SEQ_GTFS
